import { isDesk } from './roles';
import { Prisma, User } from '@prisma/client';
import { z } from 'zod';
import { addMinutes } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { db } from './db';
import { banker } from './auth';
import {
  extractEmail,
  extractionSchema,
  newEmailContent,
  generateDraft,
  type Extraction,
} from './extraction';
import { analyse, type Analysis } from './analysis';
import { availableSlots, conferenceTime, evaluate, isAvailable, mergeWindows, overlaps, validateInterval } from './scheduling';
import {
  domainOf,
  finalizeAsks,
  internalDomains,
  resolveConference,
  securityFlags,
  senderTrust,
  SUSPICIOUS_FLAG,
  type SenderTrust,
} from './email-trust';
import {
  askSummary,
  duplicatesFor,
  findCandidates,
  isOpenMeeting,
  isOpenRequest,
  requestOwner,
  rollupEmailStatus,
  type Names,
} from './review-rules';
import {
  stripSensitiveQuotes,
  clientQuestions,
  findSensitive,
  outsideAllowlist,
  replySubject,
} from './outbound';
import { SimulatedOutlook } from './outlook';
import { meetingIcs } from './ics';
import { accessTokenFor, outlookStatus } from './outlook-service';
import { replyInThread, sendMail } from './graph';
import { parseRequestText } from './request-parser';
import { answerQuestion, llmPhrase } from './ask';
import { computeMetrics, extractionEdited } from './metrics';
import { availabilityMode } from './review-rules';
import { mockExtractAsks } from './rule-parser';
import { now } from './clock';
import { getResourceState, handleResourceCommand } from './resource-service';
type Tx = Prisma.TransactionClient;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
async function audit(
  tx: Tx,
  user: User,
  action: string,
  entityType: string,
  entityId: string,
  before?: unknown,
  after?: unknown,
) {
  // Searchable columns: the issuer, meeting and email the change is about, and its reason.
  const pick = (k: string) => {
    for (const o of [after, before] as Record<string, unknown>[])
      if (o && typeof o === 'object' && typeof o[k] === 'string' && o[k]) return o[k] as string;
    return null;
  };
  await tx.auditLog.create({
    data: {
      actorId: user.id,
      action,
      entityType,
      entityId,
      issuerId: pick('issuerId'),
      meetingId: entityType === 'Meeting' ? entityId : pick('meetingId'),
      emailId: entityType === 'Email' ? entityId : pick('emailId') || pick('sourceEmailId'),
      note: pick('reason') || pick('note'),
      ...(before ? { before: json(before) } : {}),
      ...(after ? { after: json(after) } : {}),
    },
  });
}
/**
 * Record a schedule change on a meeting (optimistic-concurrency version, "changed since" stamp)
 * and tell the people who own it — issuer owner, its bankers, the requesting salesperson and the
 * investor's coverage salesperson — unless they made the change themselves.
 */
async function markMeetingChanged(tx: Tx, user: User, meetingId: string, summary: string) {
  const m = await tx.meeting.update({
    where: { id: meetingId },
    data: { version: { increment: 1 }, changedAt: new Date(), changedBy: user.id, changeSummary: summary },
  });
  const [issuer, investor, request, coverage] = await Promise.all([
    tx.issuer.findUnique({ where: { id: m.issuerId } }),
    tx.investor.findUnique({ where: { id: m.investorId } }),
    m.requestId ? tx.meetingRequest.findUnique({ where: { id: m.requestId } }) : null,
    tx.meetingCoverageAssignment.findMany({ where: { meetingId } }),
  ]);
  const people = new Set(
    [issuer?.ownerId, request?.salespersonId, investor?.coverageSalesId, ...m.bankerIds, ...coverage.map((c) => c.bankerId)].filter(
      (x): x is string => Boolean(x) && x !== user.id,
    ),
  );
  if (people.size)
    await tx.notification.createMany({
      data: [...people].map((userId) => ({
        userId,
        actorId: user.id,
        kind: 'meeting-changed',
        text: `${user.name}: ${issuer?.name} × ${investor?.name} — ${summary}`,
        meetingId,
        requestId: m.requestId,
      })),
    });
  return m;
}
/** Tell the salesperson on a request (and the account's coverage salesperson) what happened. */
/** Tell the sales people on an email (sender, forwarder, cc) what happened to one of its asks. */
async function notifyEmailSales(
  tx: Tx,
  user: User,
  email: { id: string; sender: string; forwardedBy: string | null; cc: string[]; to: string[]; subject: string },
  text: string,
) {
  const addresses = [email.sender, email.forwardedBy, ...email.cc, ...email.to].filter(Boolean).map((x) => x!.toLowerCase());
  const sales = await tx.user.findMany({ where: { role: 'SALES', email: { in: addresses, mode: 'insensitive' } } });
  const people = sales.filter((u) => u.id !== user.id);
  if (people.length)
    await tx.notification.createMany({
      data: people.map((u) => ({ userId: u.id, actorId: user.id, kind: 'email-ask', text: `${email.subject}: ${text}`, emailId: email.id })),
    });
}
async function notifyRequest(tx: Tx, user: User, r: { id: string; issuerId: string; investorId: string; salespersonId: string }, text: string) {
  const investor = await tx.investor.findUnique({ where: { id: r.investorId } });
  const issuer = await tx.issuer.findUnique({ where: { id: r.issuerId } });
  const people = new Set([r.salespersonId, investor?.coverageSalesId].filter((x): x is string => Boolean(x) && x !== user.id));
  if (people.size)
    await tx.notification.createMany({
      data: [...people].map((userId) => ({
        userId,
        actorId: user.id,
        kind: 'request-changed',
        text: `${investor?.name} × ${issuer?.name}: ${text}`,
        requestId: r.id,
      })),
    });
}
/** Issuers on hold (from an escalation) need an explicit override reason for any change. */
async function checkHold(tx: Tx, issuerId: string | null | undefined, override: string | undefined) {
  if (!issuerId) return null;
  const issuer = await tx.issuer.findUnique({ where: { id: issuerId } });
  if (!issuer?.holdChanges) return null;
  if (!override || override.trim().length < 5)
    throw new Error(
      `All changes for ${issuer.name} are on hold (${issuer.holdReason || 'client escalation'}). Give an override reason to proceed.`,
    );
  return `Hold override for ${issuer.name}: ${override.trim()}`;
}
async function lock(tx: Tx) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(817204)`;
}
async function resources(
  tx: Tx,
  conferenceId: string,
  issuerId: string,
  investorId?: string,
  excludeMeetingId?: string,
) {
  const availability = await tx.availability.findMany({ where: { conferenceId, issuerId } });
  const meetings = await tx.meeting.findMany({
    where: {
      conferenceId,
      status: { in: ['Confirmed', 'Tentative'] },
      id: excludeMeetingId ? { not: excludeMeetingId } : undefined,
      OR: [{ issuerId }, ...(investorId ? [{ investorId }] : [])],
    },
  });
  // Only the future can be offered: windows are cut at "now" (rounded up to the next half hour).
  const t = now();
  const from = new Date(Math.ceil(+t / 1800000) * 1800000);
  return {
    windows: availability
      .filter((a) => a.kind === 'Available' && +a.end > +from)
      .map((a) => (+a.start < +from ? { ...a, start: from } : a)),
    busy: [...availability.filter((a) => a.kind !== 'Available'), ...meetings],
  };
}
async function refresh(tx: Tx, conferenceId: string) {
  const [issuers, investors] = await Promise.all([tx.issuer.findMany(), tx.investor.findMany()]);
  for (const m of await tx.meeting.findMany({ where: { conferenceId, status: 'Confirmed' } })) {
    const windows = await tx.availability.findMany({
      where: { conferenceId, issuerId: m.issuerId, kind: 'Available' },
    });
    const open = await tx.action.findFirst({
      where: { type: 'Availability conflict', meetingId: m.id, status: 'Open' },
    });
    if (!isAvailable(m, windows, [])) {
      if (!open) {
        const issuer = issuers.find((i) => i.id === m.issuerId)!;
        await tx.action.create({
          data: {
            conferenceId,
            issuerId: m.issuerId,
            investorId: m.investorId,
            meetingId: m.id,
            type: 'Availability conflict',
            title: `${issuer.name} × ${investors.find((v) => v.id === m.investorId)?.name || 'investor'} is outside approved availability`,
            assignedTo: issuer.ownerId,
            priority: 'Urgent',
            recommendation:
              'Confirmed meeting preserved. Obtain consent before rescheduling or cancelling.',
          },
        });
      }
    } else if (open) await tx.action.update({ where: { id: open.id }, data: { status: 'Resolved' } });
  }
  // A cancelled meeting can no longer conflict with anything.
  const cancelled = await tx.meeting.findMany({ where: { conferenceId, status: 'Cancelled' }, select: { id: true } });
  if (cancelled.length)
    await tx.action.updateMany({
      where: { type: 'Availability conflict', status: 'Open', meetingId: { in: cancelled.map((m) => m.id) } },
      data: { status: 'Resolved' },
    });
  for (const r of await tx.meetingRequest.findMany({
    where: { conferenceId, status: { notIn: ['Confirmed', 'Cancelled'] } },
  })) {
    const { windows, busy } = await resources(tx, r.conferenceId, r.issuerId, r.investorId);
    const c = await tx.conference.findUniqueOrThrow({ where: { id: conferenceId } });
    const result = evaluate(r, windows, busy, r.duration, c.slotMinutes);
    await tx.meetingRequest.update({
      where: { id: r.id },
      data: {
        status:
          result.status === 'Potential Match' && r.status === 'Awaiting Banker Approval'
            ? 'Awaiting Banker Approval'
            : result.status,
      },
    });
  }
}
async function validateReferences(
  tx: Tx,
  conferenceId: string,
  issuerId: string,
  investorId?: string,
) {
  const c = await tx.conference.findUniqueOrThrow({ where: { id: conferenceId } });
  await tx.issuer.findUniqueOrThrow({ where: { id: issuerId } });
  if (investorId) await tx.investor.findUniqueOrThrow({ where: { id: investorId } });
  return c;
}
/**
 * Domains a draft may go to without a second confirmation: the exact registered domains of the
 * parties on this thread or meeting, plus the bank's own. Anything else is "outside".
 */
async function draftDomains(tx: Tx | typeof db, at: { emailId?: string | null; meetingId?: string | null }) {
  const [issuers, investors] = await Promise.all([tx.issuer.findMany(), tx.investor.findMany()]);
  const registered = new Set([...issuers, ...investors].map((x) => domainOf(x.contactEmail)));
  const out = new Set(internalDomains());
  if (at.emailId) {
    const email = await tx.email.findUnique({ where: { id: at.emailId } });
    const thread = email ? await tx.email.findMany({ where: { threadId: email.threadId } }) : [];
    for (const e of thread)
      for (const a of [e.sender, e.originalSender || '', ...e.to, ...e.cc]) {
        const d = domainOf(a);
        if (d && registered.has(d)) out.add(d);
      }
  }
  if (at.meetingId) {
    const m = await tx.meeting.findUnique({ where: { id: at.meetingId } });
    if (m) {
      const i = issuers.find((x) => x.id === m.issuerId),
        v = investors.find((x) => x.id === m.investorId);
      for (const x of [i, v]) if (x) out.add(domainOf(x.contactEmail));
    }
  }
  return [...out];
}
/**
 * One reply per email covering all its asks: what was done, what we need to know, and open
 * alternatives where a requested time does not work. Escalations get an apologetic, human note.
 * Nothing is written to the database.
 */
async function buildReply(tx: Tx | typeof db, user: User, emailId: string) {
  const email = await tx.email.findUniqueOrThrow({ where: { id: emailId }, include: { proposals: { orderBy: { askIndex: 'asc' } } } });
  const [issuers, investors, conferences, actions] = await Promise.all([
    tx.issuer.findMany(),
    tx.investor.findMany(),
    tx.conference.findMany(),
    tx.action.findMany({ where: { emailId } }),
  ]);
  const names = namesFrom(issuers, investors);
  const internal = internalDomains();
  const allowed = await draftDomains(tx, { emailId });
  const outer = senderTrust(email.sender, { issuers, investors, internal });
  const client = senderTrust(email.originalSender || email.sender, { issuers, investors, internal });
  const perspective = client.issuerId ? 'issuer' : client.investorId ? 'investor' : 'other';
  const to = outer.status === 'unverified' ? [] : [email.sender];
  const cc = outer.status === 'unverified'
    ? []
    : email.cc.filter((x) => x.toLowerCase() !== user.email.toLowerCase() && allowed.includes(domainOf(x)));
  const signature = /\n\s*([A-Z][a-z]+)(?:\s+[A-Z][a-z]+)?\s*(?:\n|$)/.exec(`\n${email.newContent}`.split(/\n(?:thanks|thx|best|regards|cheers)[^\n]*\n/i).pop() || '');
  // The reply goes to whoever sent it to us: greet the colleague when they forwarded it.
  const forwarder = email.forwardedBy
    ? (await tx.user.findFirst({ where: { email: { equals: email.forwardedBy, mode: 'insensitive' } } }))?.name
    : null;
  const first = (forwarder || email.originalSenderName || '').split(' ')[0] || signature?.[1] || '';
  const hi = first ? `Hi ${first},` : 'Hi,';
  const asks = email.proposals.map((x) => ({ p: x, e: x.extraction as unknown as Extraction }));
  if (email.escalation) {
    const esc = asks.find((a) => a.e.category === 'Escalation / complaint');
    const owner = actions.find((a) => a.proposalId === esc?.p.id)?.assignedTo;
    const ownerName = owner ? (await tx.user.findUnique({ where: { id: owner } }))?.name : null;
    const issuer = esc?.e.issuerId ? names.issuer(esc.e.issuerId) : 'your';
    const body = [
      hi,
      '',
      `I'm sorry — you're right to raise this, and it should not have happened.`,
      `${ownerName && ownerName !== user.name ? `${ownerName} is` : 'I am'} now your single point of contact for the ${issuer === 'your' ? '' : `${issuer} `}schedule and will call you today.`,
      '',
      'We will not make any further changes to your schedule until we have spoken.',
      '',
      'Best regards,',
      user.name,
    ].join('\n');
    return { to, cc, subject: replySubject(email.subject), body, allowedDomains: allowed, kind: 'escalation', questionAskIds: [] as string[] };
  }
  const done: string[] = [],
    questions: string[] = [],
    alternatives: string[] = [],
    questionAskIds: string[] = [];
  for (const { p, e } of asks) {
    const zone = conferences.find((c) => c.id === e.conferenceId)?.timezone || 'America/New_York';
    const other = perspective === 'issuer' ? names.investor(e.investorId) : perspective === 'investor' ? names.issuer(e.issuerId) : `${names.issuer(e.issuerId)} / ${names.investor(e.investorId)}`;
    const target = e.windows.find((w) => w.kind === 'availability');
    if (p.status === 'Approved') {
      if (e.operation === 'reschedule' && target) done.push(`We've moved the ${other} meeting to ${formatInTimeZone(target.start, zone, 'EEEE h:mm a')}.`);
      else if (e.operation === 'cancel') done.push(`We've cancelled the ${other} meeting.`);
      else if (e.category === 'New Meeting Request') done.push(`We've passed the ${other} request on and will confirm the time shortly.`);
      else if (e.category === 'Issuer Availability Update') done.push(`We've updated your availability.`);
      else if (e.operation === 'update') done.push(`We've noted ${e.attendees} attendees for the ${other} meeting.`);
      continue;
    }
    if (!['Pending', 'Clarification requested'].includes(p.status)) continue;
    // A requested time that is taken: offer the nearest open times instead of asking blindly.
    if (target && e.conferenceId && e.issuerId && e.investorId && ['reschedule', 'inquiry'].includes(e.operation)) {
      const c = conferences.find((x) => x.id === e.conferenceId)!;
      const free = await resources(tx as Tx, c.id, e.issuerId, e.investorId, e.meetingId || undefined);
      const len = (+new Date(target.end) - +new Date(target.start)) / 60000;
      const fits = e.flexible
        ? availableSlots(free.windows, free.busy, e.durationMinutes || c.slotMinutes, c.slotMinutes).some(
            (x) => +new Date(x.start) >= +new Date(target.start) && +new Date(x.end) <= +new Date(target.end),
          )
        : isAvailable(target, free.windows, free.busy);
      if (!fits) {
        const near = availableSlots(free.windows, free.busy, len, c.slotMinutes)
          .sort((a, b) => Math.abs(+new Date(a.start) - +new Date(target.start)) - Math.abs(+new Date(b.start) - +new Date(target.start)))
          .slice(0, 3)
          .sort((a, b) => +new Date(a.start) - +new Date(b.start))
          .map((x) => formatInTimeZone(x.start, zone, 'EEE h:mm a'));
        alternatives.push(
          `${formatInTimeZone(target.start, zone, 'EEEE h:mm a')} isn't available for the ${other} meeting${near.length ? ` — we could offer ${near.join(', ')}` : ''}. Would one of those work?`,
        );
        questionAskIds.push(p.id);
        continue;
      }
    }
    const q = e.missing.length || e.conditional
      ? clientQuestions(e, { issuer: e.issuerId ? names.issuer(e.issuerId) : null, investor: e.investorId ? names.investor(e.investorId) : null, conference: null }, perspective, zone)
      : [];
    if (e.conditional) q.push(`Just to confirm — should we go ahead with the change only if ${e.condition.replace(/[.\s]+$/, '').replace(/^(?:if|or)\s+/i, '')}?`);
    if (q.length) {
      questions.push(...q);
      questionAskIds.push(p.id);
    }
  }
  const parts = [hi, '', 'Thanks for your note.'];
  if (done.length) parts.push('', ...done);
  if (alternatives.length) parts.push('', ...alternatives);
  if (questions.length)
    parts.push('', questions.length === 1 ? questions[0] : `Could you help with the following:\n${[...new Set(questions)].map((q) => `- ${q}`).join('\n')}`);
  if (!done.length && !alternatives.length && !questions.length) parts.push("We're on it and will confirm shortly.");
  if (questionAskIds.length) parts.push('', "We haven't changed anything else on the schedule yet.");
  parts.push('', 'Best regards,', user.name);
  const { text } = stripSensitiveQuotes(parts.join('\n'));
  return { to, cc, subject: replySubject(email.subject), body: text, allowedDomains: allowed, kind: 'reply', questionAskIds };
}
async function makeConfirmationDraft(tx: Tx, user: User, meetingId: string) {
  const m = await tx.meeting.findUniqueOrThrow({ where: { id: meetingId } }),
    c = await tx.conference.findUniqueOrThrow({ where: { id: m.conferenceId } }),
    i = await tx.issuer.findUniqueOrThrow({ where: { id: m.issuerId } }),
    v = await tx.investor.findUniqueOrThrow({ where: { id: m.investorId } });
  const email = m.sourceEmailId
    ? await tx.email.findUnique({ where: { id: m.sourceEmailId } })
    : null;
  // To: the meeting's registered contacts (verified). Others on the chain are suggestions only.
  const chain = email ? [email.sender, ...email.to, ...email.cc] : [];
  await tx.draft.updateMany({ where: { meetingId: m.id, status: 'Draft', kind: 'confirmation' }, data: { status: 'Superseded' } });
  return tx.draft.create({
    data: {
      meetingId: m.id,
      emailId: email?.id,
      createdBy: user.id,
      sender: user.email,
      kind: 'confirmation',
      to: [i.contactEmail, v.contactEmail],
      cc: [],
      allowedDomains: await draftDomains(tx, { emailId: email?.id, meetingId: m.id }),
      historicalParticipants: [...new Set(chain)].filter((x) => ![i.contactEmail, v.contactEmail].includes(x)),
      subject: `${c.name} | ${i.name} × ${v.name} — meeting confirmation`,
      body: `Hello,\n\nYour meeting is confirmed for ${formatInTimeZone(m.start, c.timezone, 'EEEE, MMMM d, h:mm a')}–${formatInTimeZone(m.end, c.timezone, 'h:mm a')} (${c.timezone}).\n\nIssuer: ${i.name}\nInvestor: ${v.name}\nLocation: ${m.location || 'To be confirmed'}\n\nA meeting-specific calendar attachment will accompany this draft.\n\nBest regards,\n${user.name}`,
    },
  });
}
/** Past meetings and times are history: they cannot be moved, cancelled or confirmed. */
/**
 * One room per meeting: with a cube, the location is the cube's; a typed location is allowed only
 * when there is no cube (e.g. "BlackRock Boston office", a dial-in). Typing a different room next to
 * a cube is refused instead of exporting two rooms.
 */
function roomLocation(typed: string, cube: { name: string; location: string } | null, fallback: string) {
  const t = typed.trim();
  if (!cube) return t || fallback;
  const label = `${cube.name} · ${cube.location}`;
  if (t && t !== label && t !== cube.location && !t.toLowerCase().startsWith(cube.name.toLowerCase()) && !/dial|zoom|teams|phone|webex/i.test(t))
    throw new Error(`The location “${t}” conflicts with the room ${cube.name}. Clear the location or remove the room.`);
  return /dial|zoom|teams|phone|webex/i.test(t) ? `${label} · ${t}` : label;
}
function assertNotPast(m: { start: Date; end: Date }, what = 'meeting') {
  const t = +now();
  if (+m.end <= t) throw new Error(`This ${what} already took place.`);
  if (+m.start <= t) throw new Error(`This ${what} is under way and can no longer be changed.`);
}
async function confirmRequest(
  tx: Tx,
  user: User,
  id: string,
  location: string,
  sourceEmailId?: string,
) {
  const r = await tx.meetingRequest.findUniqueOrThrow({ where: { id } });
  if (['Confirmed', 'Cancelled'].includes(r.status))
    throw new Error('Request is already confirmed or cancelled.');
  if (+r.start <= +now()) throw new Error('This time has already passed. Pick a new time from the alternatives.');
  const { windows, busy } = await resources(tx, r.conferenceId, r.issuerId, r.investorId);
  if (!isAvailable(r, windows, busy))
    throw new Error('This slot is no longer available. Review the alternatives.');
  const m = await tx.meeting.create({
    data: {
      requestId: r.id,
      conferenceId: r.conferenceId,
      issuerId: r.issuerId,
      investorId: r.investorId,
      start: r.start,
      end: r.end,
      status: 'Confirmed',
      location,
      bankerIds: [user.id],
      approvedRecipients: [],
      approvedBy: user.id,
      sourceEmailId: sourceEmailId || r.sourceEmailId,
      ...(r.attendees ? { expectedAttendees: r.attendees } : {}),
    },
  });
  await tx.meetingRequest.update({ where: { id }, data: { status: 'Confirmed' } });
  await tx.action.updateMany({
    where: { requestId: id, status: 'Open' },
    data: { status: 'Resolved' },
  });
  await makeConfirmationDraft(tx, user, m.id);
  await notifyRequest(tx, user, r, `confirmed for ${formatInTimeZone(m.start, (await tx.conference.findUniqueOrThrow({ where: { id: m.conferenceId } })).timezone, 'EEE h:mm a')}`);
  await audit(tx, user, 'Meeting approved', 'Meeting', m.id, r, m);
  await refresh(tx, r.conferenceId);
  return m;
}
/** A moved meeting keeps its bankers and room, but they must be re-checked. */
async function markResourcesForReview(tx: Tx, user: User, m: { id: string; conferenceId: string; issuerId: string; investorId: string }) {
  await tx.meetingCoverageAssignment.updateMany({
    where: { meetingId: m.id },
    data: { assignmentStatus: 'Needs Review' },
  });
  await tx.meetingCubeAssignment.updateMany({
    where: { meetingId: m.id },
    data: { assignmentStatus: 'Needs Review' },
  });
  await tx.action.create({
    data: {
      conferenceId: m.conferenceId,
      issuerId: m.issuerId,
      investorId: m.investorId,
      meetingId: m.id,
      type: 'Resource allocation',
      title: 'Rescheduled meeting needs resource review',
      assignedTo: user.id,
      priority: 'High',
      recommendation: 'Re-run allocation to revalidate banker coverage and meeting cube availability.',
    },
  });
}
const intervalSchema = z.object({ start: z.string().datetime(), end: z.string().datetime() });
const requestSchema = intervalSchema.extend({
  conferenceId: z.string(),
  issuerId: z.string(),
  investorId: z.string(),
  duration: z.number().int().min(15).max(180),
  notes: z.string().max(4000).default(''),
  priority: z.enum(['Normal', 'High', 'Urgent']).default('Normal'),
  alternativeDates: z.array(z.string()).default([]),
  attendees: z.number().int().min(1).max(500).optional(),
  /** Bankers may log a request on behalf of a salesperson. */
  salespersonId: z.string().optional(),
});

const SELECT_UNCERTAINTY = 'Select and verify the existing meeting or request';
const namesFrom = (
  issuers: { id: string; name: string }[],
  investors: { id: string; name: string }[],
): Names => ({
  issuer: (id) => issuers.find((i) => i.id === id)?.name || 'Unassociated',
  investor: (id) => investors.find((i) => i.id === id)?.name || '—',
});
/** Registered issuer/investor contact domains plus the bank's own domains. */
async function allowedDomains(tx: Tx | typeof db) {
  const [issuers, investors] = await Promise.all([tx.issuer.findMany(), tx.investor.findMany()]);
  return [
    ...new Set([...issuers, ...investors].map((p) => domainOf(p.contactEmail)).concat(internalDomains())),
  ];
}
/** Conferences where an issuer or investor already has meetings, requests or availability. */
async function involvement(issuerIds: string[], investorIds: string[]) {
  if (!issuerIds.length && !investorIds.length) return [];
  const or = [
    ...(issuerIds.length ? [{ issuerId: { in: issuerIds } }] : []),
    ...(investorIds.length ? [{ investorId: { in: investorIds } }] : []),
  ];
  const [meetings, requests, availability] = await Promise.all([
    db.meeting.findMany({ where: { OR: or }, select: { conferenceId: true } }),
    db.meetingRequest.findMany({ where: { OR: or }, select: { conferenceId: true } }),
    issuerIds.length
      ? db.availability.findMany({ where: { issuerId: { in: issuerIds } }, select: { conferenceId: true } })
      : [],
  ]);
  return [...new Set([...meetings, ...requests, ...availability].map((x) => x.conferenceId))];
}
const ingestSchema = z.object({
  messageId: z.string().min(1).max(200),
  threadId: z.string().min(1).max(200),
  sender: z.string().email(),
  to: z.array(z.string().email()),
  cc: z.array(z.string().email()).default([]),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(50000),
  conferenceId: z.string().optional(),
  issuerId: z.string().optional(),
  source: z.enum(['manual', 'outlook']).default('manual'),
  graphId: z.string().max(500).optional(),
  receivedAt: z.string().datetime().optional(),
  skipUnrelated: z.boolean().default(false),
});
type IngestInput = z.infer<typeof ingestSchema>;
/** Load what the analysis needs from the database and read the email. */
async function analyseEmail(p: IngestInput) {
  const [conferences, issuers, investors, users, meetings] = await Promise.all([
    db.conference.findMany(),
    db.issuer.findMany(),
    db.investor.findMany(),
    db.user.findMany(),
    db.meeting.findMany({ where: { status: 'Confirmed' } }),
  ]);
  return analyse(p, {
    conferences,
    issuers,
    investors,
    users,
    meetings,
    internal: internalDomains(),
    today: formatInTimeZone(now(), 'America/New_York', 'yyyy-MM-dd'),
    now: now(),
    involvement,
    extract: extractEmail,
  });
}

/** One proposal and one queue action per ask. */
function escalationFrom(a: Analysis) {
  if (a.trust.investorId) return a.investorNames?.[a.trust.investorId] || null;
  if (a.trust.issuerId) return a.issuers.find((i) => i.id === a.trust.issuerId)?.name || null;
  return null;
}
async function writeAsks(tx: Tx, user: User, emailId: string, a: Analysis) {
  if (a.protectMeetingId) {
    const reason = a.escalationReasons.find((r) => /threat/i.test(r)) || 'Investor asked that it not move again';
    await tx.meeting.update({ where: { id: a.protectMeetingId }, data: { protected: true, protectedReason: reason, protectedBy: user.id } });
    await audit(tx, user, 'Meeting protected (investor threat)', 'Meeting', a.protectMeetingId, undefined, { emailId, reason });
  }
  for (const [askIndex, e] of a.asks.filter((x) => x.needsReview).entries()) {
    const proposal = await tx.proposal.create({
      data: { emailId, askIndex, summary: e.summary, extraction: json(e) },
    });
    const issuer = a.issuers.find((i) => i.id === e.issuerId);
    const escalation = e.category === 'Escalation / complaint';
    const owner = escalation ? a.addressed?.id || issuer?.ownerId : issuer?.ownerId;
    const doubts = e.uncertainties.filter((u) => !u.startsWith(SELECT_UNCERTAINTY));
    const trusted = !a.suspicious;
    await tx.action.create({
      data: {
        type: e.category,
        // An escalation is titled with the company that complained (the sender), not the issuer named.
        title: escalation
          ? `${escalationFrom(a) || issuer?.name || 'Client'} · ${e.summary}`
          : `${issuer?.name || 'Needs triage'} · ${e.summary}`,
        conferenceId: e.conferenceId,
        issuerId: e.issuerId,
        investorId: e.investorId,
        emailId,
        proposalId: proposal.id,
        meetingId: e.meetingId,
        assignedTo: owner || null,
        ccUserIds: escalation && issuer?.ownerId && issuer.ownerId !== owner ? [issuer.ownerId] : [],
        priority: escalation ? 'Urgent' : !trusted || doubts.length || e.fromEscalation ? 'High' : 'Normal',
        recommendation: escalation
          ? 'Acknowledge, assign one owner and reply to the client today.'
          : !trusted
            ? 'Suspicious email — report it, or confirm with the registered contact before acting.'
            : doubts.length
              ? 'Resolve uncertainty and review proposed changes'
              : 'Review source evidence and approve changes',
      },
    });
  }
}
const emailFields = (a: Analysis) => {
  const real = a.asks.filter((x) => x.category !== 'Escalation / complaint');
  const first = real[0] || a.asks[0];
  const categories = [...new Set((real.length ? real : a.asks).map((x) => x.category))];
  return {
    conferenceId: first.conferenceId,
    issuerId: first.issuerId || a.asks[0].issuerId,
    investorId: real.length <= 1 ? first.investorId : null,
    category: categories.length > 1 ? 'Multiple asks' : first.category,
    originalSender: a.originalSender,
    originalSenderName: a.originalSenderName,
    forwardedBy: a.forwardedBy,
    escalation: a.escalation,
    escalationReasons: a.escalationReasons,
    suspicious: a.suspicious,
    status: a.asks.some((x) => x.needsReview) ? 'Pending review' : 'Ignored',
    senderStatus: a.trust.status,
    securityFlags: a.flags,
    contextNote: a.contextNote,
  };
};
async function ingestEmail(user: User, input: unknown) {
  banker(user);
  const p = ingestSchema.parse(input);
  if (await db.email.findUnique({ where: { messageId: p.messageId } }))
    throw new Error('This message has already been ingested.');
  const a = await analyseEmail(p);
  // Personal mail that has nothing to do with a conference is never stored.
  if (p.skipUnrelated && a.asks.every((x) => x.category === 'Unrelated Email')) return null;
  return db.$transaction(async (tx) => {
    const mail = await tx.email.create({
      data: {
        messageId: p.messageId,
        threadId: p.threadId,
        sender: p.sender,
        to: p.to,
        cc: p.cc,
        subject: p.subject,
        body: p.body,
        newContent: a.content,
        source: p.source,
        graphId: p.graphId,
        ...emailFields(a),
        ...(p.receivedAt ? { receivedAt: new Date(p.receivedAt) } : {}),
      },
    });
    await writeAsks(tx, user, mail.id, a);
    await audit(tx, user, 'Email ingested', 'Email', mail.id, undefined, {
      asks: a.asks,
      parser: a.parser,
      senderStatus: a.trust.status,
      securityFlags: a.flags,
      contextNote: a.contextNote,
    });
    return mail;
  });
}
/** "Which event?" — re-read an email for the event the banker picked (only while nothing is decided). */
async function reassignEmail(user: User, input: unknown) {
  banker(user);
  const p = z
    .object({ emailId: z.string(), conferenceId: z.string().optional(), treatAsConference: z.boolean().default(false) })
    .parse(input);
  const email = await db.email.findUniqueOrThrow({ where: { id: p.emailId }, include: { proposals: true } });
  if (email.proposals.some((x) => x.status !== 'Pending'))
    throw new Error('Some asks were already decided; correct the event on each remaining ask instead.');
  const conference = p.conferenceId
    ? await db.conference.findUniqueOrThrow({ where: { id: p.conferenceId } })
    : null;
  const a = await analyseEmail({
    ...ingestSchema.parse({
      messageId: email.messageId,
      threadId: email.threadId,
      sender: email.sender,
      to: email.to,
      cc: email.cc,
      subject: email.subject,
      body: email.body,
      receivedAt: email.receivedAt.toISOString(),
    }),
    conferenceId: conference?.id,
  });
  if (conference) a.contextNote = `Event set to ${conference.name} by ${user.name}.`;
  if (p.treatAsConference) {
    // "Treat as conference email": an ignored email goes to review as a question at least.
    for (const ask of a.asks)
      if (ask.category === 'Unrelated Email')
        Object.assign(ask, { category: 'General Conference Inquiry', operation: 'inquiry', needsReview: true });
    a.contextNote = [a.contextNote, `Marked as a conference email by ${user.name}.`].filter(Boolean).join(' ');
  }
  return db.$transaction(async (tx) => {
    await tx.action.deleteMany({ where: { emailId: email.id, status: 'Open' } });
    await tx.proposal.deleteMany({ where: { emailId: email.id } });
    await tx.email.update({ where: { id: email.id }, data: emailFields(a) });
    await writeAsks(tx, user, email.id, a);
    await audit(
      tx,
      user,
      p.treatAsConference ? 'Ignored email treated as conference email' : 'Email event set',
      'Email',
      email.id,
      { conferenceId: email.conferenceId, status: email.status, asks: email.proposals.map((x) => x.extraction) },
      { conferenceId: conference?.id ?? a.asks[0]?.conferenceId, asks: a.asks },
    );
    return { ok: true };
  });
}

/* ------------------------------------------------------------------ manual meeting control */

/** Open email asks about this meeting (same issuer + investor), offered as "Mark handled manually". */
async function openAsksFor(tx: Tx, m: { id: string; issuerId: string; investorId: string; conferenceId: string }) {
  const proposals = await tx.proposal.findMany({
    where: { status: { in: ['Pending', 'Clarification requested'] } },
    include: { email: { select: { subject: true, sender: true } } },
  });
  return proposals
    .filter((x) => {
      const e = x.extraction as unknown as Extraction;
      return (
        e.meetingId === m.id ||
        (e.issuerId === m.issuerId && e.investorId === m.investorId && ['cancel', 'reschedule', 'update', 'confirm'].includes(e.operation))
      );
    })
    .map((x) => ({ id: x.id, summary: x.summary, subject: x.email.subject, sender: x.email.sender }));
}

const meetingFields = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  duration: z.number().int().min(15).max(240),
  location: z.string().max(200).default(''),
  /** Meeting cube; null clears it, omitted keeps it. */
  cubeId: z.string().nullable().optional(),
  bankerIds: z.array(z.string()).max(6).default([]),
  attendees: z.number().int().min(1).max(500),
});
type SlotInput = {
  id?: string;
  conferenceId: string;
  issuerId: string;
  investorId: string;
  start: Date;
  end: Date;
  bankerIds: string[];
  attendees: number;
  cubeId?: string | null;
};
/**
 * Hard conflicts (double-booked issuer, investor, banker or room; room too small) block a change.
 * Soft ones (outside the issuer's stated availability, banker marked unavailable) need an override
 * with a reason.
 */
async function slotCheck(tx: Tx | typeof db, m: SlotInput) {
  const c = await tx.conference.findUniqueOrThrow({ where: { id: m.conferenceId } });
  validateInterval(m, c);
  const hard: string[] = [],
    soft: string[] = [];
  const [issuers, investors, users] = await Promise.all([tx.issuer.findMany(), tx.investor.findMany(), tx.user.findMany()]);
  const iss = (id: string) => issuers.find((i) => i.id === id)?.name || id;
  const inv = (id: string) => investors.find((i) => i.id === id)?.name || id;
  const who = (id: string) => users.find((u) => u.id === id)?.name || 'A banker';
  const at = (d: Date) => formatInTimeZone(d, c.timezone, 'EEE h:mm a');
  const others = (
    await tx.meeting.findMany({
      where: { conferenceId: m.conferenceId, status: 'Confirmed', ...(m.id ? { id: { not: m.id } } : {}) },
    })
  ).filter((o) => overlaps(o, m));
  for (const o of others) {
    if (o.issuerId === m.issuerId) hard.push(`${iss(m.issuerId)} already meets ${inv(o.investorId)} at ${at(o.start)}.`);
    if (o.investorId === m.investorId) hard.push(`${inv(m.investorId)} already meets ${iss(o.issuerId)} at ${at(o.start)}.`);
  }
  const coverage = others.length
    ? await tx.meetingCoverageAssignment.findMany({ where: { meetingId: { in: others.map((o) => o.id) } } })
    : [];
  for (const b of m.bankerIds) {
    const busy = others.find((o) => o.bankerIds.includes(b) || coverage.some((a) => a.meetingId === o.id && a.bankerId === b));
    if (busy) hard.push(`${who(b)} is already covering ${iss(busy.issuerId)} × ${inv(busy.investorId)} at ${at(busy.start)}.`);
  }
  if (m.bankerIds.length) {
    const away = await tx.bankerAvailability.findMany({
      where: { conferenceId: m.conferenceId, bankerId: { in: m.bankerIds }, status: { not: 'Available' } },
    });
    for (const a of away.filter((a) => overlaps(a, m))) soft.push(`${who(a.bankerId)} is marked unavailable then.`);
  }
  if (m.cubeId) {
    const cube = await tx.meetingCube.findUniqueOrThrow({ where: { id: m.cubeId } });
    if (cube.capacity < m.attendees) hard.push(`${cube.name} seats ${cube.capacity}; ${m.attendees} attendees expected.`);
    const taken = others.length
      ? await tx.meetingCubeAssignment.findFirst({ where: { cubeId: m.cubeId, meetingId: { in: others.map((o) => o.id) } } })
      : null;
    if (taken) {
      const o = others.find((x) => x.id === taken.meetingId)!;
      hard.push(`${cube.name} is booked for ${iss(o.issuerId)} × ${inv(o.investorId)} at ${at(o.start)}.`);
    }
  }
  const availability = await tx.availability.findMany({ where: { conferenceId: m.conferenceId, issuerId: m.issuerId } });
  const windows = availability.filter((a) => a.kind === 'Available');
  if (!isAvailable(m, windows, [])) soft.push(`Outside ${iss(m.issuerId)}'s approved availability.`);
  for (const a of availability.filter((a) => a.kind !== 'Available' && overlaps(a, m)))
    soft.push(`Overlaps a ${a.kind === 'Blocked' ? 'time the issuer said does not work' : 'hold'} (${at(a.start)}–${formatInTimeZone(a.end, c.timezone, 'h:mm a')}).`);
  return { hard: [...new Set(hard)], soft: [...new Set(soft)], conference: c };
}
async function assignResources(tx: Tx, user: User, meetingId: string, bankerIds: string[], cubeId: string | null | undefined) {
  const current = await tx.meetingCoverageAssignment.findMany({ where: { meetingId } });
  await tx.meetingCoverageAssignment.deleteMany({ where: { meetingId, bankerId: { notIn: bankerIds } } });
  for (const [i, bankerId] of bankerIds.entries()) {
    const data = { coverageRole: i === 0 ? 'Primary' : 'Support', assignmentStatus: 'Approved', assignedBy: user.id };
    if (current.some((a) => a.bankerId === bankerId))
      await tx.meetingCoverageAssignment.update({ where: { meetingId_bankerId: { meetingId, bankerId } }, data });
    else await tx.meetingCoverageAssignment.create({ data: { meetingId, bankerId, ...data } });
  }
  if (cubeId === null) await tx.meetingCubeAssignment.deleteMany({ where: { meetingId } });
  else if (cubeId)
    await tx.meetingCubeAssignment.upsert({
      where: { meetingId },
      create: { meetingId, cubeId, assignmentStatus: 'Approved', assignedBy: user.id },
      update: { cubeId, assignmentStatus: 'Approved', assignedBy: user.id },
    });
}
async function meetingCommand(user: User, type: string, input: unknown): Promise<unknown> {
  banker(user);
  if (type === 'meetingCheck') {
    const p = meetingFields
      .extend({ id: z.string().optional(), conferenceId: z.string(), issuerId: z.string(), investorId: z.string() })
      .parse(input);
    const c = await db.conference.findUniqueOrThrow({ where: { id: p.conferenceId } });
    const start = conferenceTime(p.date, p.time, c.timezone);
    try {
      const { hard, soft } = await slotCheck(db, { ...p, start, end: addMinutes(start, p.duration) });
      return { hard, soft };
    } catch (e) {
      return { hard: [e instanceof Error ? e.message : 'Invalid time'], soft: [] };
    }
  }
  if (type === 'meetingUpdate') {
    const p = meetingFields
      .extend({
        id: z.string(),
        reason: z.string().trim().min(3, 'Give a reason for the change.').max(500),
        override: z.boolean().default(false),
        /** The version the editor started from; a newer one means someone else changed it. */
        version: z.number().int().optional(),
        holdOverride: z.string().max(500).optional(),
      })
      .parse(input);
    return db.$transaction(async (tx) => {
      await lock(tx);
      const m = await tx.meeting.findUniqueOrThrow({ where: { id: p.id } });
      if (m.status !== 'Confirmed') throw new Error('Only confirmed meetings can be edited.');
      assertNotPast(m);
      if (p.version !== undefined && p.version !== m.version) {
        const who = m.changedBy ? (await tx.user.findUnique({ where: { id: m.changedBy } }))?.name : null;
        throw new Error(
          `Changed by ${who || 'someone else'} while you were editing (${m.changeSummary || 'updated'}). Reload the meeting and reapply your change.`,
        );
      }
      const holdNote = await checkHold(tx, m.issuerId, p.holdOverride);
      const c = await tx.conference.findUniqueOrThrow({ where: { id: m.conferenceId } });
      const start = conferenceTime(p.date, p.time, c.timezone),
        end = addMinutes(start, p.duration);
      if (m.protected && (+start !== +m.start || +end !== +m.end) && !p.override)
        throw new Error(
          `The investor said this meeting must not move again (${m.protectedReason}). Tick "Schedule anyway" with your reason to move it.`,
        );
      const check = await slotCheck(tx, { ...m, id: m.id, start, end, bankerIds: p.bankerIds, attendees: p.attendees, cubeId: p.cubeId });
      if (check.hard.length) throw new Error(check.hard.join(' '));
      if (check.soft.length && !p.override) throw new Error(`${check.soft.join(' ')} Tick "Schedule anyway" to keep it.`);
      const cube = p.cubeId ? await tx.meetingCube.findUnique({ where: { id: p.cubeId } }) : null;
      const location = cube ? roomLocation(p.location, cube, m.location) : p.location.trim() || (p.cubeId === null ? '' : m.location);
      const moved = +start !== +m.start || +end !== +m.end;
      const before = {
        ...m,
        coverage: await tx.meetingCoverageAssignment.findMany({ where: { meetingId: m.id } }),
        cube: await tx.meetingCubeAssignment.findUnique({ where: { meetingId: m.id } }),
      };
      const updated = await tx.meeting.update({
        where: { id: m.id },
        data: { start, end, location, bankerIds: p.bankerIds, expectedAttendees: p.attendees },
      });
      await assignResources(tx, user, m.id, p.bankerIds, p.cubeId);
      if (m.requestId && moved)
        await tx.meetingRequest.update({ where: { id: m.requestId }, data: { start, end, duration: p.duration } });
      const changed = [
        moved && 'time',
        (location !== m.location || (p.cubeId !== undefined && (p.cubeId || null) !== (before.cube?.cubeId || null))) && 'room',
        before.coverage.map((a) => a.bankerId).join() !== p.bankerIds.join() && 'bankers',
        p.attendees !== m.expectedAttendees && 'attendees',
      ].filter(Boolean) as string[];
      if (moved || location !== m.location) {
        await tx.draft.updateMany({ where: { meetingId: m.id, status: 'Draft' }, data: { status: 'Superseded' } });
        await makeConfirmationDraft(tx, user, m.id);
      }
      const summary = [
        moved && `moved to ${formatInTimeZone(start, c.timezone, 'EEE h:mm a')}`,
        changed.includes('room') && `room ${location || 'cleared'}`,
        changed.includes('bankers') && 'bankers changed',
        changed.includes('attendees') && `${p.attendees} attendees`,
      ]
        .filter(Boolean)
        .join(', ');
      const final = await markMeetingChanged(tx, user, m.id, summary || 'details updated');
      await audit(tx, user, `Meeting edited (${changed.join(', ') || 'no change'})`, 'Meeting', m.id, before, {
        ...updated,
        coverage: p.bankerIds,
        cubeId: p.cubeId,
        reason: [p.reason, holdNote].filter(Boolean).join(' · '),
        overrides: p.override ? check.soft : [],
      });
      await refresh(tx, m.conferenceId);
      return { ...final, openAsks: await openAsksFor(tx, final) };
    });
  }
  if (type === 'meetingCancel') {
    const p = z
      .object({
        id: z.string(),
        reason: z.string().trim().min(3, 'A reason is required to cancel.').max(500),
        version: z.number().int().optional(),
        holdOverride: z.string().max(500).optional(),
        protectedOverride: z.string().max(500).optional(),
      })
      .parse(input);
    return db.$transaction(async (tx) => {
      await lock(tx);
      const m = await tx.meeting.findUniqueOrThrow({ where: { id: p.id } });
      if (m.status === 'Cancelled') throw new Error('Meeting already cancelled.');
      assertNotPast(m);
      if (m.protected && (p.protectedOverride || '').trim().length < 5)
        throw new Error(`This meeting is protected (${m.protectedReason}). Give an override reason to cancel it.`);
      if (m.protected) p.reason = `${p.reason} · Protected-meeting override: ${p.protectedOverride}`;
      if (p.version !== undefined && p.version !== m.version)
        throw new Error(`Changed by someone else while you were looking (${m.changeSummary || 'updated'}). Reload and try again.`);
      const holdNote = await checkHold(tx, m.issuerId, p.holdOverride);
      const updated = await tx.meeting.update({ where: { id: m.id }, data: { status: 'Cancelled' } });
      if (m.requestId) await tx.meetingRequest.update({ where: { id: m.requestId }, data: { status: 'Cancelled' } });
      await tx.draft.updateMany({ where: { meetingId: m.id, status: 'Draft' }, data: { status: 'Superseded' } });
      await tx.action.updateMany({ where: { meetingId: m.id, status: 'Open' }, data: { status: 'Resolved' } });
      const final = await markMeetingChanged(tx, user, m.id, `Cancelled: ${p.reason}`);
      await audit(tx, user, 'Meeting cancelled', 'Meeting', m.id, m, { ...updated, reason: [p.reason, holdNote].filter(Boolean).join(' · ') });
      await refresh(tx, m.conferenceId);
      return { ...final, openAsks: await openAsksFor(tx, final) };
    });
  }
  if (type === 'meetingCreate') {
    const p = meetingFields
      .extend({
        conferenceId: z.string(),
        issuerId: z.string(),
        investorId: z.string(),
        reason: z.string().trim().max(500).default(''),
        override: z.boolean().default(false),
      })
      .parse(input);
    return db.$transaction(async (tx) => {
      await lock(tx);
      const c = await validateReferences(tx, p.conferenceId, p.issuerId, p.investorId);
      const start = conferenceTime(p.date, p.time, c.timezone),
        end = addMinutes(start, p.duration);
      const check = await slotCheck(tx, { ...p, start, end });
      if (check.hard.length) throw new Error(check.hard.join(' '));
      if (check.soft.length && (!p.override || p.reason.length < 3))
        throw new Error(`${check.soft.join(' ')} Tick "Schedule anyway" and give a reason to keep it.`);
      const cube = p.cubeId ? await tx.meetingCube.findUnique({ where: { id: p.cubeId } }) : null;
      const m = await tx.meeting.create({
        data: {
          conferenceId: c.id,
          issuerId: p.issuerId,
          investorId: p.investorId,
          start,
          end,
          status: 'Confirmed',
          location: roomLocation(p.location, cube, ''),
          bankerIds: p.bankerIds,
          approvedRecipients: [],
          approvedBy: user.id,
          expectedAttendees: p.attendees,
        },
      });
      await tx.meetingCoverageRequirement.create({ data: { meetingId: m.id, requiredBankerCount: 2, requiredPrimaryCount: 1 } });
      await assignResources(tx, user, m.id, p.bankerIds, p.cubeId);
      await makeConfirmationDraft(tx, user, m.id);
      await markMeetingChanged(tx, user, m.id, 'Created manually');
      await audit(tx, user, 'Meeting created manually', 'Meeting', m.id, undefined, {
        ...m,
        cubeId: p.cubeId,
        reason: p.reason,
        overrides: p.override ? check.soft : [],
      });
      await refresh(tx, c.id);
      return m;
    });
  }
  return undefined;
}
export async function command(user: User, type: string, input: unknown): Promise<unknown> {
  if (type === 'ingest') return ingestEmail(user, input);
  if (type === 'reassignEmail') return reassignEmail(user, input);
  if (type === 'replyPreview') {
    banker(user);
    const p = z.object({ emailId: z.string() }).parse(input);
    const existing = await db.draft.findFirst({
      where: { emailId: p.emailId, status: 'Draft', kind: { in: ['reply', 'escalation', ''] } },
      orderBy: { createdAt: 'desc' },
    });
    return { ...(await buildReply(db, user, p.emailId)), existingDraftId: existing?.id || null };
  }
  if (type === 'replySave') {
    banker(user);
    const p = z
      .object({
        emailId: z.string(),
        to: z.array(z.string().email()),
        cc: z.array(z.string().email()),
        subject: z.string().min(1).max(500),
        body: z.string().min(1).max(10000),
        /** Asks the reply asks about; they move to "Waiting on reply". */
        askIds: z.array(z.string()).default([]),
      })
      .parse(input);
    return db.$transaction(async (tx) => {
      const email = await tx.email.findUniqueOrThrow({ where: { id: p.emailId } });
      const preview = await buildReply(tx, user, email.id);
      // One reply draft per email: saving again updates it.
      const existing = await tx.draft.findFirst({
        where: { emailId: email.id, status: 'Draft', kind: { in: ['reply', 'escalation', ''] } },
      });
      const data = { to: p.to, cc: p.cc, subject: p.subject, body: p.body, allowedDomains: preview.allowedDomains, kind: preview.kind };
      const d = existing
        ? await tx.draft.update({ where: { id: existing.id }, data })
        : await tx.draft.create({
            data: {
              ...data,
              emailId: email.id,
              createdBy: user.id,
              sender: user.email,
              historicalParticipants: [...new Set([email.sender, ...email.to, ...email.cc])].filter(
                (x) => x.toLowerCase() !== user.email.toLowerCase() && !p.to.includes(x) && !p.cc.includes(x),
              ),
            },
          });
      const asks = await tx.proposal.findMany({ where: { id: { in: p.askIds }, emailId: email.id, status: 'Pending' } });
      for (const a of asks) {
        await tx.proposal.update({ where: { id: a.id }, data: { status: 'Clarification requested', reviewerId: user.id } });
        await tx.action.updateMany({
          where: { proposalId: a.id },
          data: { recommendation: 'Waiting on the client; follow up on the reply' },
        });
      }
      if (asks.length) {
        const statuses = (await tx.proposal.findMany({ where: { emailId: email.id } })).map((x) => x.status);
        await tx.email.update({ where: { id: email.id }, data: { status: rollupEmailStatus(statuses) } });
      }
      await audit(tx, user, existing ? 'Reply draft updated' : 'Reply drafted', 'Draft', d.id, existing || undefined, {
        ...d,
        emailId: email.id,
        issuerId: email.issuerId,
        askedAbout: asks.map((a) => a.summary),
      });
      return d;
    });
  }
  if (type === 'reviewCheck') {
    // What would block or complicate approving this ask, before anyone clicks Approve.
    banker(user);
    const p = z.object({ id: z.string(), extraction: extractionSchema.optional(), meetingId: z.string().optional() }).parse(input);
    const proposal = await db.proposal.findUniqueOrThrow({ where: { id: p.id }, include: { email: true } });
    const e: Extraction = p.extraction || extractionSchema.parse(proposal.extraction);
    const [issuers, investors] = await Promise.all([db.issuer.findMany(), db.investor.findMany()]);
    const asker = senderTrust(proposal.email.originalSender || proposal.email.sender, { issuers, investors, internal: internalDomains() });
    const target = e.windows.find((w) => w.kind === 'availability');
    const meeting = p.meetingId ? await db.meeting.findUnique({ where: { id: p.meetingId } }) : null;
    const issuer = issuers.find((i) => i.id === e.issuerId);
    const out = {
      hard: [] as string[],
      soft: [] as string[],
      issuerAsked: Boolean(e.issuerId && asker.status === 'verified' && asker.issuerId === e.issuerId),
      investorAsked: Boolean(e.investorId && asker.status === 'verified' && asker.investorId === e.investorId),
      stale: null as string | null,
      hold: issuer?.holdChanges ? issuer.holdReason || 'Client escalation' : null,
      protected: meeting?.protected ? meeting.protectedReason : null,
      availability: null as null | { mode: 'narrow' | 'extend'; days: { day: string; before: string[]; after: string[]; outside: string[] }[] },
      timeNote: null as string | null,
    };
    // Availability: show the per-day diff before approving (narrow = the day becomes exactly these windows).
    if (['add'].includes(e.operation) && e.conferenceId && e.issuerId) {
      const c = await db.conference.findUniqueOrThrow({ where: { id: e.conferenceId } });
      const mode = availabilityMode([...e.evidence, ...e.windows.map((w) => w.evidence)].join(' ') || proposal.email.newContent);
      const fresh = e.windows.filter((w) => w.kind === 'availability');
      const dayOf = (d: Date | string) => formatInTimeZone(d, c.timezone, 'yyyy-MM-dd');
      const label = (w: { start: Date | string; end: Date | string }) => `${formatInTimeZone(w.start, c.timezone, 'h:mm')}–${formatInTimeZone(w.end, c.timezone, 'h:mm a')}`;
      const current = await db.availability.findMany({ where: { conferenceId: c.id, issuerId: e.issuerId, kind: 'Available' }, orderBy: { start: 'asc' } });
      const booked = await db.meeting.findMany({ where: { conferenceId: c.id, issuerId: e.issuerId, status: 'Confirmed' } });
      const days = [...new Set(fresh.map((w) => dayOf(w.start)))];
      out.availability = {
        mode,
        days: days.map((day) => {
          const before = current.filter((w) => dayOf(w.start) === day);
          const added = fresh.filter((w) => dayOf(w.start) === day).map((w) => ({ start: new Date(w.start), end: new Date(w.end) }));
          const after = mode === 'narrow' ? added : mergeWindows([...before, ...added]).map((w) => ({ start: new Date(w.start), end: new Date(w.end) }));
          const outside = booked.filter((m) => dayOf(m.start) === day && !after.some((w) => +w.start <= +m.start && +w.end >= +m.end));
          return {
            day: formatInTimeZone(new Date(`${day}T17:00:00Z`), 'UTC', 'EEE MMM d'),
            before: before.map(label),
            after: after.map(label),
            outside: outside.map((m) => `${investors.find((i) => i.id === m.investorId)?.name} ${formatInTimeZone(m.start, c.timezone, 'h:mm a')}`),
          };
        }),
      };
    }
    // Time zones said in the email ("2:00pm CT") are spelled out against the event's zone.
    if (target && e.conferenceId) {
      const c = await db.conference.findUniqueOrThrow({ where: { id: e.conferenceId } });
      const said = [...e.evidence, target.evidence].join(' ').match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(CT|CST|CDT|Central|MT|Mountain|PT|PST|PDT|Pacific|UK|GMT|BST|London)\b/i);
      const zoneName = formatInTimeZone(new Date(target.start), c.timezone, 'zzz');
      if (said) out.timeNote = `${said[1].toUpperCase().replace(/\s+/g, ' ')} ${said[2]} = ${formatInTimeZone(new Date(target.start), c.timezone, 'h:mm a')} ${zoneName} (event time)`;
      if (meeting && e.operation === 'reschedule' && +new Date(target.start) === +meeting.start)
        out.timeNote = `${out.timeNote ? `${out.timeNote} — ` : ''}same time as now: no time change. Handle the rest of the ask (e.g. dial-in or room) instead.`;
    }
    if (meeting?.changedAt && +meeting.changedAt > +(proposal.refreshedAt ?? proposal.createdAt)) {
      const who = meeting.changedBy ? (await db.user.findUnique({ where: { id: meeting.changedBy } }))?.name : null;
      out.stale = `${meeting.changeSummary || 'Updated'}${who ? ` by ${who}` : ''}`;
    }
    if (target && e.conferenceId && e.issuerId && e.investorId && !e.flexible && ['reschedule', 'inquiry'].includes(e.operation)) {
      try {
        const check = await slotCheck(db, {
          id: meeting?.id,
          conferenceId: e.conferenceId,
          issuerId: e.issuerId,
          investorId: e.investorId,
          start: new Date(target.start),
          end: new Date(target.end),
          bankerIds: meeting?.bankerIds || [],
          attendees: e.attendees || meeting?.expectedAttendees || 1,
        });
        out.hard = check.hard;
        out.soft = check.soft;
      } catch (err) {
        out.hard = [err instanceof Error ? err.message : 'Invalid time'];
      }
    }
    if (e.operation === 'update' && meeting && e.attendees) {
      const room = await db.meetingCubeAssignment.findUnique({ where: { meetingId: meeting.id } });
      const cube = room ? await db.meetingCube.findUnique({ where: { id: room.cubeId } }) : null;
      if (!cube) out.soft.push(`No room assigned yet for ${e.attendees} people.`);
      else if (cube.capacity < e.attendees) out.soft.push(`${cube.name} seats ${cube.capacity}; ${e.attendees} expected — a bigger room is needed.`);
    }
    return out;
  }
  if (type === 'meetingProtect') {
    // Protect a meeting ("do not move"): any move or cancel then needs an override reason.
    banker(user);
    const p = z.object({ id: z.string(), protected: z.boolean(), reason: z.string().trim().max(300).default('') }).parse(input);
    if (p.protected && p.reason.length < 3) throw new Error('Say why the meeting is protected (e.g. the investor asked).');
    return db.$transaction(async (tx) => {
      const before = await tx.meeting.findUniqueOrThrow({ where: { id: p.id } });
      const after = await tx.meeting.update({
        where: { id: p.id },
        data: p.protected ? { protected: true, protectedReason: p.reason, protectedBy: user.id } : { protected: false, protectedReason: '', protectedBy: null },
      });
      await audit(tx, user, p.protected ? 'Meeting protected' : 'Meeting protection removed', 'Meeting', p.id, { protected: before.protected, protectedReason: before.protectedReason, issuerId: before.issuerId }, { protected: after.protected, reason: p.reason || before.protectedReason, issuerId: before.issuerId });
      return { ok: true };
    });
  }
  if (type === 'issuerHold') {
    banker(user);
    const p = z.object({ issuerId: z.string(), hold: z.boolean(), reason: z.string().max(500).default('') }).parse(input);
    if (p.hold && p.reason.trim().length < 3) throw new Error('Say why changes are on hold.');
    return db.$transaction(async (tx) => {
      const before = await tx.issuer.findUniqueOrThrow({ where: { id: p.issuerId } });
      const after = await tx.issuer.update({
        where: { id: p.issuerId },
        data: p.hold
          ? { holdChanges: true, holdReason: p.reason.trim(), holdSetBy: user.id, holdSetAt: new Date() }
          : { holdChanges: false, holdReason: '', holdSetBy: null, holdSetAt: null },
      });
      if (before.ownerId && before.ownerId !== user.id)
        await tx.notification.create({
          data: {
            userId: before.ownerId,
            actorId: user.id,
            kind: 'hold',
            text: p.hold ? `${user.name} put all ${before.name} changes on hold: ${p.reason}` : `${user.name} released the hold on ${before.name}`,
          },
        });
      await audit(tx, user, p.hold ? 'Issuer changes put on hold' : 'Issuer hold released', 'Issuer', p.issuerId, { holdChanges: before.holdChanges, issuerId: p.issuerId }, { holdChanges: after.holdChanges, issuerId: p.issuerId, reason: p.reason });
      return after;
    });
  }
  if (type === 'notificationsRead') {
    await db.notification.updateMany({ where: { userId: user.id, readAt: null }, data: { readAt: new Date() } });
    return { ok: true };
  }
  if (type === 'request') {
    const p = requestSchema.parse(input);
    return db.$transaction(async (tx) => {
      await lock(tx);
      const c = await validateReferences(tx, p.conferenceId, p.issuerId, p.investorId);
      validateInterval(p, c);
      if ((+new Date(p.end) - +new Date(p.start)) / 60000 !== p.duration)
        throw new Error('Requested interval must equal the meeting duration.');
      const issuer = await tx.issuer.findUniqueOrThrow({ where: { id: p.issuerId } });
      let owner = user.id;
      if (p.salespersonId && p.salespersonId !== user.id) {
        banker(user);
        const sales = await tx.user.findUniqueOrThrow({ where: { id: p.salespersonId } });
        if (sales.role !== 'SALES') throw new Error('Pick a salesperson as the requester.');
        owner = sales.id;
      }
      const { windows, busy } = await resources(tx, p.conferenceId, p.issuerId, p.investorId);
      const result = evaluate(p, windows, busy, p.duration, c.slotMinutes);
      const r = await tx.meetingRequest.create({
        data: {
          ...p,
          start: new Date(p.start),
          end: new Date(p.end),
          salespersonId: owner,
          bankerId: issuer.ownerId,
          status: result.status,
        },
      });
      await tx.action.create({
        data: {
          type: 'Meeting request',
          title: `New investor request · ${issuer.name}`,
          conferenceId: p.conferenceId,
          issuerId: p.issuerId,
          investorId: p.investorId,
          requestId: r.id,
          assignedTo: issuer.ownerId,
          priority: p.priority,
          recommendation: 'Review availability and obtain issuer consent before confirming',
        },
      });
      await audit(tx, user, 'Meeting requested', 'MeetingRequest', r.id, undefined, r);
      return r;
    });
  }
  if (type === 'alternative') {
    const p = z.object({ id: z.string(), start: z.string().datetime() }).parse(input);
    return db.$transaction(async (tx) => {
      await lock(tx);
      const r = await tx.meetingRequest.findUniqueOrThrow({ where: { id: p.id } });
      if (!isDesk(user.role) && r.salespersonId !== user.id) throw new Error('Forbidden');
      if (['Confirmed', 'Cancelled'].includes(r.status))
        throw new Error('Request cannot be changed.');
      const slot = { start: new Date(p.start), end: addMinutes(new Date(p.start), r.duration) };
      const c = await tx.conference.findUniqueOrThrow({ where: { id: r.conferenceId } });
      validateInterval(slot, c);
      const { windows, busy } = await resources(tx, r.conferenceId, r.issuerId, r.investorId);
      if (!isAvailable(slot, windows, busy))
        throw new Error('Selected alternative is no longer available.');
      const updated = await tx.meetingRequest.update({
        where: { id: r.id },
        data: { ...slot, status: 'Awaiting Banker Approval' },
      });
      await tx.action.create({
        data: {
          type: 'Alternative selected',
          title: 'Sales selected an alternative time',
          conferenceId: r.conferenceId,
          issuerId: r.issuerId,
          investorId: r.investorId,
          requestId: r.id,
          assignedTo: r.bankerId,
          recommendation: 'Obtain consent and approve the selected slot',
        },
      });
      await notifyRequest(tx, user, r, `time changed to an alternative by ${user.name}`);
      await audit(tx, user, 'Alternative selected', 'MeetingRequest', r.id, r, updated);
      return updated;
    });
  }
  if (type === 'confirm') {
    banker(user);
    const p = z
      .object({ id: z.string(), location: z.string().default(''), consent: z.literal(true) })
      .parse(input);
    return db.$transaction(async (tx) => {
      await lock(tx);
      return confirmRequest(tx, user, p.id, p.location);
    });
  }
  if (type === 'availability') {
    banker(user);
    const p = intervalSchema
      .extend({
        conferenceId: z.string(),
        issuerId: z.string(),
        kind: z.enum(['Available', 'Blocked', 'Hold']).default('Available'),
        operation: z.enum(['add', 'replace', 'remove', 'narrow']).default('add'),
        replaceConfirmed: z.boolean().default(false),
      })
      .parse(input);
    return db.$transaction(async (tx) => {
      await lock(tx);
      const c = await validateReferences(tx, p.conferenceId, p.issuerId);
      validateInterval(p, c);
      const before = await tx.availability.findMany({
        where: { conferenceId: p.conferenceId, issuerId: p.issuerId },
      });
      await applyAvailability(tx, user, p);
      await audit(tx, user, `${p.operation} ${p.kind}`, 'Availability', p.issuerId, before, p);
      await refresh(tx, p.conferenceId);
      return { ok: true };
    });
  }
  if (type === 'release') {
    banker(user);
    const p = z.object({ id: z.string() }).parse(input);
    return db.$transaction(async (tx) => {
      await lock(tx);
      const a = await tx.availability.findUniqueOrThrow({ where: { id: p.id } });
      await tx.availability.delete({ where: { id: a.id } });
      await refresh(tx, a.conferenceId);
      await audit(tx, user, 'Availability released', 'Availability', a.id, a);
      return { ok: true };
    });
  }
  if (type === 'review') {
    banker(user);
    const p = z
      .object({
        id: z.string(),
        decision: z.enum(['approve', 'reject', 'clarify', 'edit', 'acknowledge', 'refresh', 'handled', 'quarantine']),
        extraction: extractionSchema.optional(),
        note: z.string().max(2000).default(''),
        uncertaintyResolved: z.boolean().default(false),
        replaceConfirmed: z.boolean().default(false),
        requestId: z.string().optional(),
        meetingId: z.string().optional(),
        consent: z.boolean().default(false),
        /** The reviewer typed why an unverified sender can be trusted. */
        senderOverride: z.boolean().default(false),
        /** The reviewer confirmed a second meeting between the same issuer and investor. */
        duplicateConfirmed: z.boolean().default(false),
        assignTo: z.string().optional(),
        /** Reason to change an issuer that is on hold after an escalation. */
        holdOverride: z.string().max(500).optional(),
        /** Reason to move/cancel a meeting an investor said must not move again. */
        protectedOverride: z.string().max(500).optional(),
        /** The reviewer confirmed the condition of a conditional ask holds. */
        conditionMet: z.boolean().default(false),
        /** Who agreed to a move: both the issuer and the investor must have. */
        consentParties: z.array(z.enum(['issuer', 'investor'])).default([]),
        /** The issuer asked for a time outside its stated availability: extend it (audited). */
        extendAvailability: z.boolean().default(false),
        /** New meeting from an email with consent: confirm it now instead of leaving a request. */
        confirmNow: z.boolean().default(false),
      })
      .parse(input);
    return db.$transaction(async (tx) => {
      await lock(tx);
      const proposal = await tx.proposal.findUniqueOrThrow({
        where: { id: p.id },
        include: { email: true },
      });
      if (p.decision === 'quarantine') {
        // Report phishing: nothing in this email is applied; every open ask is closed.
        const email = proposal.email;
        await tx.proposal.updateMany({
          where: { emailId: email.id, status: { in: ['Pending', 'Clarification requested'] } },
          data: { status: 'Rejected', reviewerId: user.id, reviewNote: `Reported as phishing: ${p.note}`.trim() },
        });
        await tx.email.update({ where: { id: email.id }, data: { status: 'Quarantined' } });
        await tx.action.updateMany({
          where: { emailId: email.id, status: { in: ['Open', 'Acknowledged'] } },
          data: { status: 'Rejected', recommendation: 'Reported as phishing and quarantined' },
        });
        await tx.draft.updateMany({ where: { emailId: email.id, status: 'Draft' }, data: { status: 'Superseded' } });
        await audit(tx, user, 'Reported as phishing', 'Email', email.id, { status: email.status }, {
          status: 'Quarantined',
          sender: email.sender,
          securityFlags: email.securityFlags,
          note: p.note,
        });
        return { ok: true };
      }
      if (!['Pending', 'Clarification requested'].includes(proposal.status))
        throw new Error('This ask has already been reviewed.');
      const [issuers, investors, conferences, users] = await Promise.all([
        tx.issuer.findMany(),
        tx.investor.findMany(),
        tx.conference.findMany(),
        tx.user.findMany(),
      ]);
      const names = namesFrom(issuers, investors);
      const e: Extraction = p.extraction || extractionSchema.parse(proposal.extraction);
      const zone = conferences.find((c) => c.id === e.conferenceId)?.timezone;
      e.summary = askSummary(e, names, zone);
      const email = proposal.email;
      const issuerName = issuers.find((i) => i.id === e.issuerId)?.name;
      const actionScope = { OR: [{ proposalId: p.id }, { emailId: email.id, proposalId: null }] };
      if (p.decision === 'refresh') {
        // The reviewer has looked at what changed on the meeting since the email arrived.
        await tx.proposal.update({ where: { id: p.id }, data: { refreshedAt: new Date(), extraction: json(e) } });
        await audit(tx, user, 'Ask re-checked after a meeting change', 'Proposal', p.id, undefined, { emailId: email.id, note: p.note });
        return { ok: true };
      }
      if (p.decision === 'handled') {
        // Done outside the email flow (e.g. a manual move); recorded, not rejected.
        await tx.proposal.update({
          where: { id: p.id },
          data: { status: 'Resolved', reviewedAt: new Date(), reviewerId: user.id, reviewNote: `Handled manually${p.note ? `: ${p.note}` : ''}` },
        });
        await tx.action.updateMany({ where: actionScope, data: { status: 'Resolved', recommendation: 'Handled manually' } });
        const statuses = (await tx.proposal.findMany({ where: { emailId: email.id } })).map((x) => x.status);
        await tx.email.update({ where: { id: email.id }, data: { status: rollupEmailStatus(statuses) } });
        await audit(tx, user, 'Ask handled manually', 'Proposal', p.id, { status: proposal.status }, {
          emailId: email.id,
          issuerId: e.issuerId,
          meetingId: p.meetingId,
          note: p.note,
        });
        return { ok: true };
      }
      if (p.decision === 'edit') {
        await tx.proposal.update({
          where: { id: p.id },
          data: { extraction: json(e), summary: e.summary, reviewNote: p.note, reviewerId: user.id },
        });
        // The queue follows the corrected associations (an edited email can leave "Needs triage").
        await tx.action.updateMany({
          where: { ...actionScope, status: 'Open' },
          data: {
            type: e.category,
            title: `${issuerName || 'Needs triage'} · ${e.summary}`,
            conferenceId: e.conferenceId,
            issuerId: e.issuerId,
            investorId: e.investorId,
            ...(issuers.find((i) => i.id === e.issuerId)?.ownerId && e.category !== 'Escalation / complaint'
              ? { assignedTo: issuers.find((i) => i.id === e.issuerId)!.ownerId }
              : {}),
          },
        });
        if (proposal.askIndex === 0)
          await tx.email.update({
            where: { id: email.id },
            data: { conferenceId: e.conferenceId, issuerId: e.issuerId },
          });
        await audit(tx, user, 'Extraction corrected', 'Proposal', p.id, proposal.extraction, e);
        return { ok: true };
      }
      if (p.decision === 'acknowledge') {
        const owner = users.find((u) => u.id === p.assignTo);
        if (!owner || !isDesk(owner.role)) throw new Error('Pick the banker who owns the follow-up.');
        await tx.proposal.update({
          where: { id: p.id },
          data: { status: 'Acknowledged', reviewerId: user.id, reviewNote: p.note, extraction: json(e) },
        });
        await tx.action.updateMany({
          where: actionScope,
          data: {
            assignedTo: owner.id,
            // Acknowledged ≠ resolved: it stays with its owner until they close it.
            status: 'Acknowledged',
            priority: 'Urgent',
            recommendation: `Acknowledged by ${user.name}. ${owner.name} owns the follow-up${p.note.trim() ? `: ${p.note.trim()}` : '.'}`,
          },
        });
        const statuses = (await tx.proposal.findMany({ where: { emailId: email.id } })).map((x) => x.status);
        await tx.email.update({ where: { id: email.id }, data: { status: rollupEmailStatus(statuses) } });
        await audit(tx, user, 'Escalation acknowledged', 'Proposal', p.id, { status: proposal.status }, { owner: owner.id, note: p.note });
        return { ok: true };
      }
      let outcome: { kind: string; meetingId?: string | null; text: string } = { kind: 'none', text: 'Recorded.' };
      if (p.decision === 'approve') {
        if (e.category === 'Escalation / complaint')
          throw new Error('Escalations are acknowledged and assigned to an owner, not approved.');
        if (email.senderStatus === 'unverified' && (!p.senderOverride || p.note.trim().length < 10))
          throw new Error('Sender not verified. Type why you trust this email (at least 10 characters) before approving.');
        if (!e.conferenceId || !e.issuerId)
          throw new Error('Associate a conference and issuer before approval.');
        const [confId, issId] = [e.conferenceId, e.issuerId];
        const holdNote = await checkHold(tx, e.issuerId, p.holdOverride);
        if (e.conditional && !p.conditionMet)
          throw new Error(`This ask is conditional (“${e.condition}”). Confirm the condition holds before approving.`);
        const affected = p.meetingId ? await tx.meeting.findUnique({ where: { id: p.meetingId } }) : null;
        if (affected && ['cancel', 'reschedule', 'update'].includes(e.operation)) assertNotPast(affected);
        const proposedTimes = e.windows.filter((w) => w.kind === 'availability');
        if (['reschedule', 'inquiry', 'confirm'].includes(e.operation) && proposedTimes.length && proposedTimes.every((w) => +new Date(w.end) <= +now()))
          throw new Error('The time in this email has already passed. Reply with a new time instead.');
        if (affected?.changedAt && +affected.changedAt > +(proposal.refreshedAt ?? proposal.createdAt))
          throw new Error(
            `This meeting changed after the email arrived (${affected.changeSummary || 'updated'} by ${users.find((u) => u.id === affected.changedBy)?.name || 'someone'}). Review the change and refresh this ask first.`,
          );
        if (affected?.protected && ['cancel', 'reschedule'].includes(e.operation) && (p.protectedOverride || '').trim().length < 5)
          throw new Error(
            `The investor said this meeting must not move again (${affected.protectedReason || 'protected'}). Give an override reason to proceed.`,
          );
        if (e.operation === 'reschedule' && !(p.consentParties.includes('issuer') && p.consentParties.includes('investor')))
          throw new Error('A move needs the agreement of both the issuer and the investor. Record both before approving.');
        // The issuer itself asked for this time: offering to extend its availability is fair.
        const asker = senderTrust(email.originalSender || email.sender, { issuers, investors, internal: internalDomains() });
        const extendFor =
          p.extendAvailability && asker.status === 'verified' && asker.issuerId === e.issuerId
            ? e.windows.filter((w) => w.kind === 'availability')
            : [];
        if (p.extendAvailability && !extendFor.length)
          throw new Error('Availability can only be extended when the issuer itself asked for this time.');
        for (const w of extendFor) {
          await tx.availability.create({
            data: { conferenceId: confId, issuerId: issId, start: new Date(w.start), end: new Date(w.end), kind: 'Available', approvedBy: user.id, sourceEmailId: email.id },
          });
          await audit(tx, user, 'Availability extended (issuer asked)', 'Availability', issId, undefined, { ...w, issuerId: issId, emailId: email.id });
        }
        if (holdNote) p.note = [p.note, holdNote].filter(Boolean).join('\n');
        if (p.protectedOverride) p.note = [p.note, `Protected meeting override: ${p.protectedOverride}`].join('\n');
        if (p.consentParties.length) p.note = [p.note, `Agreed by: ${p.consentParties.join(' and ')}`].join('\n');
        if (!e.conferenceId || !e.issuerId)
          throw new Error('Associate a conference and issuer before approval.');
        const c = await validateReferences(
          tx,
          e.conferenceId,
          e.issuerId,
          e.investorId || undefined,
        );
        if (e.uncertainties.length && (!p.uncertaintyResolved || p.note.trim().length < 10))
          throw new Error('Document how every uncertainty was resolved before approval.');
        // Times the email says do not work become issuer blocks, even with no meeting booked.
        const blocks = e.windows.filter((w) => w.kind === 'unavailable');
        if (e.category === 'New Meeting Request') {
          if (!e.investorId)
            throw new Error('Select an investor in the structured extraction first.');
          const windows = e.windows.filter((w) => w.kind === 'availability');
          if (windows.length !== 1)
            throw new Error('Provide one explicit requested meeting interval.');
          let w = windows[0];
          validateInterval(w, c);
          if (e.flexible) {
            // "Any time 10–12": place the meeting in the first slot open for both sides.
            const len = e.durationMinutes || c.slotMinutes;
            const free = await resources(tx, c.id, e.issuerId, e.investorId);
            const slot = availableSlots(free.windows, free.busy, len, c.slotMinutes).find(
              (x) => +new Date(x.start) >= +new Date(w.start) && +new Date(x.end) <= +new Date(w.end),
            );
            const start = slot ? new Date(slot.start) : new Date(w.start);
            w = { ...w, start: start.toISOString(), end: addMinutes(start, len).toISOString() };
          }
          const duration = (+new Date(w.end) - +new Date(w.start)) / 60000;
          if (duration < 15 || duration > 180)
            throw new Error('Requested duration must be between 15 and 180 minutes.');
          const [existingMeetings, existingRequests] = await Promise.all([
            tx.meeting.findMany({ where: { conferenceId: c.id, issuerId: e.issuerId, investorId: e.investorId } }),
            tx.meetingRequest.findMany({ where: { conferenceId: c.id, issuerId: e.issuerId, investorId: e.investorId } }),
          ]);
          // The email answers an open request for the same pair: that request is confirmed (or
          // moved to the email's time), not duplicated.
          const answered = p.requestId ? existingRequests.find((r) => r.id === p.requestId && isOpenRequest(r.status)) : undefined;
          if (answered) {
            if (!p.consent) throw new Error('Tick that the issuer agreed before confirming.');
            const issuerName = names.issuer(e.issuerId);
            await tx.meetingRequest.update({
              where: { id: answered.id },
              data: { start: new Date(w.start), end: new Date(w.end), duration, sourceEmailId: email.id },
            });
            const m = await confirmRequest(tx, user, answered.id, '', email.id);
            outcome = { kind: 'confirmed', meetingId: m?.id || null, text: `Meeting confirmed: ${names.investor(e.investorId)} × ${issuerName} ${formatInTimeZone(w.start, c.timezone, 'EEE h:mm a')}. The open request is closed.` };
          }
          const dupes = answered ? [] : duplicatesFor(e, existingMeetings, existingRequests);
          if (dupes.length && !p.duplicateConfirmed)
            throw new Error(
              `${names.investor(e.investorId)} already has ${dupes.length === 1 ? 'a meeting or request' : `${dupes.length} meetings or requests`} with ${names.issuer(e.issuerId)}. Confirm this is an additional meeting to continue.`,
            );
          const issuer = await tx.issuer.findUniqueOrThrow({ where: { id: e.issuerId } });
          const resourcesForRequest = await resources(tx, c.id, e.issuerId, e.investorId);
          if (!answered) {
          const request = await tx.meetingRequest.create({
            data: {
              conferenceId: c.id,
              issuerId: e.issuerId,
              investorId: e.investorId,
              salespersonId: requestOwner(email, users, issuer.ownerId) || user.id,
              bankerId: issuer.ownerId,
              start: new Date(w.start),
              end: new Date(w.end),
              duration,
              alternativeDates: [],
              attendees: e.attendees,
              sourceEmailId: email.id,
              notes: `From email: ${email.subject}${e.vague.length ? ` · Alternative mentioned: ${e.vague.join('; ')}` : ''}`,
              status: evaluate(
                w,
                resourcesForRequest.windows,
                resourcesForRequest.busy,
                duration,
                c.slotMinutes,
              ).status,
            },
          });
          await tx.action.create({
            data: {
              type: 'Meeting request',
              title: `Email meeting request · ${issuer.name}`,
              conferenceId: c.id,
              issuerId: e.issuerId,
              investorId: e.investorId,
              requestId: request.id,
              assignedTo: issuer.ownerId,
              recommendation: 'Obtain issuer consent and confirm the requested meeting.',
            },
          });
          await audit(
            tx,
            user,
            'Email converted to request',
            'MeetingRequest',
            request.id,
            undefined,
            { ...request, sourceEmailId: email.id },
          );
          outcome = { kind: 'request', text: `Request created for ${names.investor(e.investorId)} × ${issuer.name}; confirm it once the time is agreed.` };
          if (p.confirmNow) {
            if (!p.consent) throw new Error('Tick that the issuer agreed before confirming.');
            if (!isAvailable(w, resourcesForRequest.windows, resourcesForRequest.busy))
              throw new Error('That time is not open for both sides. Pick an alternative or create the request only.');
            const m = await confirmRequest(tx, user, request.id, '', email.id);
            outcome = { kind: 'confirmed', meetingId: m?.id || null, text: `Meeting confirmed: ${names.investor(e.investorId)} × ${issuer.name} ${formatInTimeZone(w.start, c.timezone, 'EEE h:mm a')}.` };
          }
          }
        } else if (e.operation === 'inquiry') {
          if (!blocks.length)
            throw new Error(
              'This inquiry has no schedule change. Request clarification or resolve the action.',
            );
        } else if (['add', 'remove', 'replace'].includes(e.operation)) {
          const windows = e.windows.filter((w) => w.kind === 'availability');
          if (!windows.length && !blocks.length)
            throw new Error('Add an explicit verified time window first.');
          if (e.operation === 'replace' && !p.replaceConfirmed)
            throw new Error('Explicit replacement confirmation required.');
          for (const w of windows) validateInterval(w, c);
          if (e.operation === 'replace')
            await tx.availability.deleteMany({
              where: { conferenceId: c.id, issuerId: e.issuerId, kind: 'Available' },
            });
          // Issuer says "free 9–11 and 2–4 Wed": that day becomes exactly those windows (narrow),
          // unless it says it can ALSO do them (extend). The first window of a day narrows, the rest add.
          const mode = e.operation === 'add' ? availabilityMode([...e.evidence, ...windows.map((w) => w.evidence)].join(' ') || email.newContent) : 'extend';
          const seenDay = new Set<string>();
          for (const w of windows) {
            const day = formatInTimeZone(w.start, c.timezone, 'yyyy-MM-dd');
            const narrowNow = mode === 'narrow' && !seenDay.has(day);
            seenDay.add(day);
            await applyAvailability(tx, user, {
              ...w,
              conferenceId: c.id,
              issuerId: e.issuerId,
              operation: narrowNow ? 'narrow' : e.operation === 'replace' ? 'add' : (e.operation as 'add' | 'remove'),
              kind: e.tentative ? 'Hold' : 'Available',
              replaceConfirmed: p.replaceConfirmed,
              sourceEmailId: proposal.emailId,
            });
          }
        } else if (e.operation === 'confirm') {
          if (!p.requestId || !p.consent)
            throw new Error('Select a request and attest issuer consent.');
          const r = await tx.meetingRequest.findUniqueOrThrow({ where: { id: p.requestId } });
          if (
            r.issuerId !== e.issuerId ||
            r.conferenceId !== e.conferenceId ||
            (e.investorId && r.investorId !== e.investorId)
          )
            throw new Error('Selected request does not match the email associations.');
          const m = await confirmRequest(tx, user, p.requestId, '', proposal.emailId);
          outcome = { kind: 'confirmed', meetingId: m?.id || null, text: 'Meeting confirmed.' };
        } else if (e.operation === 'cancel' && !p.meetingId && p.requestId) {
          // "Please drop the Apollo request": the ask is about a request, not a booked meeting.
          const r = await tx.meetingRequest.findUniqueOrThrow({ where: { id: p.requestId } });
          if (r.issuerId !== e.issuerId || (e.investorId && r.investorId !== e.investorId))
            throw new Error('Selected request does not match the email.');
          if (!isOpenRequest(r.status)) throw new Error('That request is already closed.');
          await tx.meetingRequest.update({ where: { id: r.id }, data: { status: 'Cancelled' } });
          await tx.action.updateMany({ where: { requestId: r.id, status: 'Open' }, data: { status: 'Resolved' } });
          await audit(tx, user, 'Request cancelled from email', 'MeetingRequest', r.id, r, { status: 'Cancelled', emailId: email.id, issuerId: r.issuerId, note: p.note });
        } else if (e.operation === 'update') {
          // New headcount for an existing meeting; the room is re-checked against it.
          if (!p.meetingId) throw new Error('Select the meeting this update is about.');
          if (!e.attendees) throw new Error('The update has no attendee count.');
          const m = await tx.meeting.findUniqueOrThrow({ where: { id: p.meetingId } });
          if (m.issuerId !== e.issuerId || (e.investorId && m.investorId !== e.investorId))
            throw new Error('Meeting does not match the email.');
          await tx.meeting.update({ where: { id: m.id }, data: { expectedAttendees: e.attendees } });
          const room = await tx.meetingCubeAssignment.findUnique({ where: { meetingId: m.id } });
          const cube = room ? await tx.meetingCube.findUnique({ where: { id: room.cubeId } }) : null;
          if (!cube || cube.capacity < e.attendees) {
            if (room) await tx.meetingCubeAssignment.update({ where: { meetingId: m.id }, data: { assignmentStatus: 'Needs Review' } });
            await tx.action.create({
              data: {
                conferenceId: m.conferenceId,
                issuerId: m.issuerId,
                investorId: m.investorId,
                meetingId: m.id,
                type: 'Resource allocation',
                title: `${names.issuer(m.issuerId)} × ${names.investor(m.investorId)} needs a room for ${e.attendees}`,
                assignedTo: user.id,
                priority: 'High',
                recommendation: cube ? `${cube.name} seats ${cube.capacity}; ${e.attendees} expected.` : `No room assigned; ${e.attendees} expected.`,
              },
            });
          }
          await markMeetingChanged(tx, user, m.id, `Attendees now ${e.attendees}`);
          await audit(tx, user, 'Meeting attendees updated from email', 'Meeting', m.id, m, { expectedAttendees: e.attendees, emailId: email.id, issuerId: m.issuerId, note: p.note });
        } else {
          if (!p.meetingId || !p.consent)
            throw new Error('Select a meeting and attest approval for this change.');
          const m = await tx.meeting.findUniqueOrThrow({ where: { id: p.meetingId } });
          if (
            m.conferenceId !== e.conferenceId ||
            m.issuerId !== e.issuerId ||
            (e.investorId && m.investorId !== e.investorId)
          )
            throw new Error('Meeting does not match the email.');
          if (m.status === 'Cancelled') throw new Error('Meeting already cancelled.');
          if (e.operation === 'cancel') {
            await tx.meeting.update({ where: { id: m.id }, data: { status: 'Cancelled' } });
            if (m.requestId)
              await tx.meetingRequest.update({
                where: { id: m.requestId },
                data: { status: 'Cancelled' },
              });
          } else {
            const w = e.windows.find((w) => w.kind === 'availability');
            if (!w) throw new Error('A verified reschedule interval is required.');
            validateInterval(w, c);
            const { windows, busy } = await resources(
              tx,
              m.conferenceId,
              m.issuerId,
              m.investorId,
              m.id,
            );
            if (!isAvailable(w, windows, busy))
              throw new Error('Reschedule conflicts with approved availability.');
            await tx.meeting.update({
              where: { id: m.id },
              data: {
                start: new Date(w.start),
                end: new Date(w.end),
                sourceEmailId: proposal.emailId,
              },
            });
            await markResourcesForReview(tx, user, m);
            if (m.requestId)
              await tx.meetingRequest.update({
                where: { id: m.requestId },
                data: {
                  start: new Date(w.start),
                  end: new Date(w.end),
                  duration: (+new Date(w.end) - +new Date(w.start)) / 60000,
                },
              });
          }
          await tx.draft.updateMany({
            where: { meetingId: m.id, status: 'Draft' },
            data: { status: 'Superseded' },
          });
          if (e.operation === 'reschedule') await makeConfirmationDraft(tx, user, m.id);
          const moved = e.windows.find((w) => w.kind === 'availability');
          await markMeetingChanged(
            tx,
            user,
            m.id,
            e.operation === 'cancel'
              ? 'Cancelled at the client’s request'
              : `Moved to ${moved ? formatInTimeZone(moved.start, zone || 'America/New_York', 'EEE h:mm a') : 'a new time'}`,
          );
          await audit(
            tx,
            user,
            e.operation === 'cancel' ? 'Meeting cancelled from email' : 'Meeting moved from email',
            'Meeting',
            m.id,
            m,
            { ...(await tx.meeting.findUnique({ where: { id: m.id } })), sourceEmailId: email.id, reason: p.note },
          );
          // Older open asks about the same meeting are superseded by this decision.
          const olderOpen = await tx.action.findMany({ where: { status: 'Open', proposalId: { not: null }, id: { notIn: [] } } });
          for (const oa of olderOpen) {
            if (oa.proposalId === proposal.id) continue;
            const op2 = await tx.proposal.findUnique({ where: { id: oa.proposalId! }, include: { email: true } });
            const x = op2?.extraction as { meetingId?: string | null } | undefined;
            if (!op2 || op2.status !== 'Pending' || x?.meetingId !== m.id || +op2.email.receivedAt > +email.receivedAt) continue;
            const why = `Superseded by “${email.subject}” (${e.operation === 'cancel' ? 'cancelled' : 'moved'}, approved by ${user.name})`;
            await tx.action.update({ where: { id: oa.id }, data: { status: 'Resolved', recommendation: why } });
            await tx.proposal.update({ where: { id: op2.id }, data: { status: 'Resolved', reviewNote: why, reviewedAt: new Date() } });
          }
          outcome = {
            kind: e.operation === 'cancel' ? 'cancelled' : 'moved',
            meetingId: m.id,
            text: e.operation === 'cancel' ? 'Meeting cancelled.' : `Meeting moved to ${moved ? formatInTimeZone(moved.start, zone || 'America/New_York', 'EEE h:mm a') : 'the new time'}.`,
          };
        }
        for (const w of blocks) {
          validateInterval(w, c);
          const where = { conferenceId: c.id, issuerId: e.issuerId };
          // Trim any offered window that overlaps, then record the block once.
          await applyAvailability(tx, user, {
            ...w,
            ...where,
            operation: 'remove',
            kind: 'Available',
            replaceConfirmed: false,
            sourceEmailId: proposal.emailId,
          });
          const exists = await tx.availability.findFirst({
            where: { ...where, kind: 'Blocked', start: new Date(w.start), end: new Date(w.end) },
          });
          if (!exists)
            await tx.availability.create({
              data: {
                ...where,
                start: new Date(w.start),
                end: new Date(w.end),
                kind: 'Blocked',
                approvedBy: user.id,
                sourceEmailId: proposal.emailId,
              },
            });
          await audit(tx, user, 'Issuer unavailable time recorded', 'Availability', e.issuerId, null, { ...w, sourceEmailId: email.id });
        }
        await refresh(tx, c.id);
      }
      const status =
        p.decision === 'approve'
          ? 'Approved'
          : p.decision === 'reject'
            ? 'Rejected'
            : 'Clarification requested';
      await tx.proposal.update({
        where: { id: p.id },
        data: {
          status,
          extraction: json(e),
          summary: e.summary,
          reviewerId: user.id,
          reviewNote: p.note,
          reviewedAt: new Date(),
          editedOnReview: extractionEdited(proposal.extraction, e),
        },
      });
      const statuses = (await tx.proposal.findMany({ where: { emailId: email.id } })).map((x) => x.status);
      await tx.email.update({ where: { id: email.id }, data: { status: rollupEmailStatus(statuses) } });
      await tx.action.updateMany({
        where: actionScope,
        data: {
          status: p.decision === 'clarify' ? 'Open' : 'Resolved',
          recommendation:
            p.decision === 'clarify'
              ? 'Waiting on the client; review the question draft and follow up'
              : 'Review completed',
        },
      });
      // Questions to the sender are written in the reply composer (replyPreview / replySave);
      // nothing is drafted until the person saves it.
      if (p.decision !== 'clarify')
        await notifyEmailSales(tx, user, email, `“${e.summary || 'request'}” ${status === 'Approved' ? 'done' : 'not done'} by ${user.name}${p.note ? ` — ${p.note}` : ''}`);
      await audit(tx, user, `Ask ${status.toLowerCase()}`, 'Proposal', p.id, { status: proposal.status, extraction: proposal.extraction }, {
        extraction: e,
        note: p.note,
        emailId: email.id,
      });
      if (p.decision === 'approve' && outcome.kind === 'none')
        outcome = { kind: ['add', 'remove', 'replace'].includes(e.operation) ? 'availability' : e.operation, text: ['add', 'remove', 'replace'].includes(e.operation) ? 'Availability updated.' : 'Approved. Schedule updated.' };
      return { ok: true, outcome };
    });
  }
  if (type === 'action') {
    banker(user);
    const p = z
      .object({
        id: z.string(),
        status: z.enum(['Open', 'Resolved', 'Rejected']).optional(),
        assignedTo: z.string().nullable().optional(),
      })
      .parse(input);
    return db.$transaction(async (tx) => {
      const before = await tx.action.findUniqueOrThrow({ where: { id: p.id } });
      if (p.assignedTo) {
        const owner = await tx.user.findUniqueOrThrow({ where: { id: p.assignedTo } });
        banker(owner);
      }
      const a = await tx.action.update({
        where: { id: p.id },
        data: { status: p.status, assignedTo: p.assignedTo },
      });
      await audit(tx, user, 'Action updated', 'Action', p.id, before, a);
      return a;
    });
  }
  if (type === 'cancelRequest') {
    const p = z.object({ id: z.string() }).parse(input);
    return db.$transaction(async (tx) => {
      await lock(tx);
      const r = await tx.meetingRequest.findUniqueOrThrow({ where: { id: p.id } });
      if (!isDesk(user.role) && r.salespersonId !== user.id) throw new Error('Forbidden');
      if (r.status === 'Confirmed')
        throw new Error('Confirmed meetings require a banker-reviewed cancellation email.');
      await tx.meetingRequest.update({ where: { id: r.id }, data: { status: 'Cancelled' } });
      await tx.action.updateMany({ where: { requestId: r.id }, data: { status: 'Resolved' } });
      await notifyRequest(tx, user, r, `request declined by ${user.name}`);
      await audit(tx, user, 'Request cancelled', 'MeetingRequest', r.id, r);
      return { ok: true };
    });
  }
  if (type === 'requestDraft') {
    const p = z
      .object({
        id: z.string(),
        purpose: z.enum([
          'Availability inquiry',
          'Alternative time proposal',
          'Meeting confirmation',
          'Reschedule request',
          'Cancellation',
        ]),
      })
      .parse(input);
    const r = await db.meetingRequest.findUniqueOrThrow({ where: { id: p.id } });
    if (!isDesk(user.role) && r.salespersonId !== user.id) throw new Error('Forbidden');
    if (p.purpose === 'Meeting confirmation' && r.status !== 'Confirmed')
      throw new Error('Only confirmed requests can generate confirmation drafts.');
    const c = await db.conference.findUniqueOrThrow({ where: { id: r.conferenceId } }),
      i = await db.issuer.findUniqueOrThrow({ where: { id: r.issuerId } }),
      v = await db.investor.findUniqueOrThrow({ where: { id: r.investorId } });
    const facts = `${p.purpose}: ${v.name} with ${i.name}, ${c.name}, requested ${formatInTimeZone(r.start, c.timezone, 'MMM d h:mm a')} ${c.timezone}. Current status: ${r.status}. This draft does not change meeting status.`;
    const body = await generateDraft(
      facts,
      `Hello,\n\n${facts}\n\nPlease let us know your availability. Any changes remain subject to banker and issuer approval.\n\nBest regards,\n${user.name}`,
    );
    return db.$transaction(async (tx) => {
      const d = await tx.draft.create({
        data: {
          requestId: r.id,
          createdBy: user.id,
          sender: user.email,
          to: [],
          cc: [],
          historicalParticipants: [],
          subject: `${c.name} | ${p.purpose}`,
          body,
        },
      });
      await audit(tx, user, 'Communication drafted', 'Draft', d.id);
      return d;
    });
  }
  if (type === 'draft') {
    const p = z
      .object({
        id: z.string(),
        to: z.array(z.string().email()),
        cc: z.array(z.string().email()),
        subject: z.string().min(1).max(500),
        body: z.string().min(1).max(10000),
        send: z.boolean().default(false),
        recipientsApproved: z.boolean().default(false),
        /** Second confirmation for recipients outside the registered/internal domains. */
        outsideConfirmed: z.boolean().default(false),
        /** Confirmation that possible deal / MNPI terms in the body are intended, with a reason. */
        sensitiveConfirmed: z.boolean().default(false),
        sensitiveReason: z.string().max(500).default(''),
        holdOverride: z.string().max(500).optional(),
      })
      .parse(input);
    return db.$transaction(async (tx) => {
      await lock(tx);
      const d = await tx.draft.findUniqueOrThrow({ where: { id: p.id } });
      let sendConfirmations: Record<string, unknown> = {};
      if (!isDesk(user.role) && d.createdBy !== user.id) throw new Error('Forbidden');
      if (d.status !== 'Draft') throw new Error('This draft is no longer editable.');
      if (p.send) {
        banker(user);
        if (!p.recipientsApproved || !p.to.length)
          throw new Error('Review and approve at least one recipient.');
        const allowed = d.allowedDomains.length ? d.allowedDomains : await allowedDomains(tx);
        const outside = outsideAllowlist([...p.to, ...p.cc], allowed);
        if (outside.length && !p.outsideConfirmed)
          throw new Error(
            `${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} outside the parties on this thread and the bank. Confirm to send anyway.`,
          );
        const sensitive = findSensitive(`${p.subject}\n${p.body}`);
        if (sensitive.length && (!p.sensitiveConfirmed || p.sensitiveReason.trim().length < 5))
          throw new Error(
            `The draft contains possible deal / MNPI terms (${sensitive.join(', ')}). Remove them, or confirm with a reason.`,
          );
        const draftIssuer = d.meetingId
          ? (await tx.meeting.findUnique({ where: { id: d.meetingId } }))?.issuerId
          : d.emailId
            ? (await tx.email.findUnique({ where: { id: d.emailId } }))?.issuerId
            : null;
        const holdNote = await checkHold(tx, draftIssuer, p.holdOverride);
        sendConfirmations = {
          outsideRecipients: outside,
          outsideConfirmed: outside.length ? p.outsideConfirmed : undefined,
          sensitiveTerms: sensitive,
          sensitiveReason: sensitive.length ? p.sensitiveReason : undefined,
          holdOverride: holdNote || undefined,
        };
        if (d.meetingId) {
          const m = await tx.meeting.findUniqueOrThrow({ where: { id: d.meetingId } });
          if (m.status !== 'Confirmed') throw new Error('Meeting is no longer confirmed.');
          const i = await tx.issuer.findUniqueOrThrow({ where: { id: m.issuerId } }),
            v = await tx.investor.findUniqueOrThrow({ where: { id: m.investorId } }),
            bankers = await tx.user.findMany({ where: { role: 'BANKER' } });
          // The calendar attachment only goes to the meeting's own contacts and internal bankers.
          const allowed = [i.contactEmail, v.contactEmail, ...bankers.map((b) => b.email)].map((x) =>
            x.toLowerCase(),
          );
          if ([...p.to, ...p.cc].some((x) => !allowed.includes(x.toLowerCase())))
            throw new Error(
              'Meeting attachment recipients must be the meeting contacts or internal bankers.',
            );
          await tx.meeting.update({
            where: { id: m.id },
            data: { approvedRecipients: [...p.to, ...p.cc] },
          });
        }
      }
      let delivery: { mode: 'outlook' | 'simulated'; receipt: string } | null = null;
      if (p.send) delivery = await deliverDraft(tx, user, d, p);
      const updated = await tx.draft.update({
        where: { id: d.id },
        data: {
          to: p.to,
          cc: p.cc,
          subject: p.subject,
          body: p.body,
          ...(delivery
            ? {
                status: delivery.mode === 'outlook' ? 'Sent' : 'Simulated sent',
                approvedBy: user.id,
                simulatedSentAt: new Date(),
                deliveryMode: delivery.mode,
                deliveryReceipt: delivery.receipt,
              }
            : {}),
        },
      });
      await audit(
        tx,
        user,
        delivery?.mode === 'outlook'
          ? 'Sent through Outlook'
          : p.send
            ? 'Delivery approved and simulated'
            : 'Draft saved',
        'Draft',
        d.id,
        d,
        { ...updated, ...sendConfirmations, reason: (sendConfirmations.sensitiveReason as string) || undefined },
      );
      return updated;
    }, { timeout: 30000, maxWait: 10000 });
  }
  if (type === 'ask') {
    const p = z.object({ question: z.string().trim().min(2).max(500) }).parse(input);
    const clients = isDesk(user.role) ? [] : await clientIds(user);
    const [conferences, issuers, investors, users, meetings, coverage, rooms, cubes, availability, emailRows] = await Promise.all([
      db.conference.findMany(),
      db.issuer.findMany({ select: { id: true, name: true, ownerId: true } }),
      db.investor.findMany({ select: { id: true, name: true, coverageSalesId: true } }),
      db.user.findMany({ select: { id: true, name: true } }),
      db.meeting.findMany({ include: { request: { select: { salespersonId: true } } } }),
      db.meetingCoverageAssignment.findMany({ select: { meetingId: true, bankerId: true } }),
      db.meetingCubeAssignment.findMany({ select: { meetingId: true, cubeId: true } }),
      db.meetingCube.findMany({ select: { id: true, name: true, capacity: true } }),
      db.availability.findMany(),
      db.email.findMany({
        where: isDesk(user.role) ? { status: { not: 'Quarantined' } } : { OR: [{ sender: { equals: user.email, mode: 'insensitive' } }, { forwardedBy: { equals: user.email, mode: 'insensitive' } }, { cc: { has: user.email } }] },
        select: { id: true, subject: true, issuerId: true, investorId: true, status: true, receivedAt: true },
        orderBy: { receivedAt: 'desc' },
        take: 300,
      }),
    ]);
    const visibleMeetingIds =
      isDesk(user.role)
        ? undefined
        : new Set(meetings.filter((m) => clients.includes(m.investorId) || m.request?.salespersonId === user.id).map((m) => m.id));
    const base = await answerQuestion(
      p.question,
      { now: now(), user, conferences, issuers, investors, users, meetings, coverage, rooms, cubes, availability, emails: emailRows, visibleMeetingIds },
      {
        historySince: async (since) => {
          const rows = await db.auditLog.findMany({
            where: { createdAt: { gte: since }, entityType: { in: ['Meeting', 'Proposal', 'MeetingRequest', 'Availability', 'Draft', 'Issuer'] } },
            orderBy: { createdAt: 'desc' },
            take: 40,
          });
          const ms = await db.meeting.findMany({ where: { id: { in: rows.map((r) => r.meetingId || r.entityId) } } });
          return rows.map((r) => {
            const m = ms.find((x) => x.id === (r.meetingId || r.entityId));
            return {
              id: r.id,
              createdAt: r.createdAt.toISOString(),
              action: r.action,
              actor: users.find((u) => u.id === r.actorId)?.name || 'System',
              note: isDesk(user.role) ? r.note : null,
              meetingId: m?.id || null,
              subject: m ? `${issuers.find((i) => i.id === m.issuerId)?.name} × ${investors.find((i) => i.id === m.investorId)?.name}` : undefined,
            };
          });
        },
        history: async (ids) => {
          const rows = await db.auditLog.findMany({
            where: { OR: [{ meetingId: { in: ids } }, { entityId: { in: ids } }] },
            orderBy: { createdAt: 'desc' },
            take: 50,
          });
          return rows.map((r) => ({
            id: r.id,
            createdAt: r.createdAt.toISOString(),
            action: r.action,
            actor: users.find((u) => u.id === r.actorId)?.name || 'System',
            // Sales see what happened, not the internal reasons.
            note: isDesk(user.role) ? r.note : null,
            meetingId: r.meetingId,
          }));
        },
      },
    );
    const answer = await llmPhrase(p.question, base);
    // Questions change nothing, so they are kept in their own log, not the audit trail.
    await db.askLog.create({ data: { userId: user.id, question: p.question.slice(0, 500), pattern: base.pattern } });
    return answer;
  }
  if (type === 'reopen') {
    // Undo for "Rejected", "Expired" and "Handled manually": the item goes back to the queue.
    banker(user);
    const p = z.object({ actionId: z.string(), reason: z.string().trim().max(500).default('') }).parse(input);
    return db.$transaction(async (tx) => {
      await lock(tx);
      const a = await tx.action.findUniqueOrThrow({ where: { id: p.actionId } });
      if (!['Rejected', 'Expired', 'Resolved'].includes(a.status)) throw new Error('Only closed items can be reopened.');
      await tx.action.update({ where: { id: a.id }, data: { status: 'Open', recommendation: p.reason ? `Reopened: ${p.reason}` : 'Reopened' } });
      if (a.proposalId) {
        const pr = await tx.proposal.findUnique({ where: { id: a.proposalId } });
        if (pr && ['Rejected', 'Expired', 'Resolved'].includes(pr.status)) {
          await tx.proposal.update({ where: { id: pr.id }, data: { status: 'Pending', reviewNote: null, reviewedAt: null } });
          const statuses = (await tx.proposal.findMany({ where: { emailId: pr.emailId } })).map((x) => x.status);
          await tx.email.update({ where: { id: pr.emailId }, data: { status: rollupEmailStatus(statuses) } });
        }
      }
      if (a.requestId) {
        const r = await tx.meetingRequest.findUnique({ where: { id: a.requestId } });
        if (r?.status === 'Expired') await tx.meetingRequest.update({ where: { id: r.id }, data: { status: 'Alternative Slots Available' } });
      }
      await audit(tx, user, 'Item reopened', 'Action', a.id, { status: a.status }, { status: 'Open', reason: p.reason, emailId: a.emailId, issuerId: a.issuerId, meetingId: a.meetingId });
      return { ok: true };
    });
  }
  if (type === 'metrics') {
    if (user.role !== 'MANAGER') throw new Error('Forbidden');
    const p = z.object({ conferenceId: z.string().optional() }).parse(input);
    return managerMetrics(p.conferenceId);
  }
  if (type === 'addAsk') {
    // A sentence the parser did not turn into an ask ("does the room have a screen?") becomes one.
    banker(user);
    const p = z.object({ emailId: z.string(), text: z.string().trim().min(3).max(1000) }).parse(input);
    return db.$transaction(async (tx) => {
      await lock(tx);
      const email = await tx.email.findUniqueOrThrow({ where: { id: p.emailId }, include: { proposals: true } });
      const [conferences, issuers, investors] = await Promise.all([tx.conference.findMany(), tx.issuer.findMany(), tx.investor.findMany()]);
      const parsed = mockExtractAsks(p.text, email.subject, { conferences, issuers, investors }, { conferenceId: email.conferenceId || undefined, issuerId: email.issuerId || undefined });
      const base = parsed.asks[0];
      const e = {
        ...base,
        conferenceId: base?.conferenceId || email.conferenceId,
        issuerId: base?.issuerId || email.issuerId,
        investorId: base?.investorId || email.investorId,
        category: base && base.category !== 'Unrelated Email' ? base.category : 'General Conference Inquiry',
        operation: base && base.category !== 'Unrelated Email' ? base.operation : 'inquiry',
        evidence: [p.text],
        summary: base?.summary && base.category !== 'Unrelated Email' ? base.summary : p.text.slice(0, 120),
        needsReview: true,
        uncertainties: base?.uncertainties || [],
      };
      const askIndex = Math.max(-1, ...email.proposals.map((x) => x.askIndex)) + 1;
      const proposal = await tx.proposal.create({ data: { emailId: email.id, askIndex, summary: e.summary, extraction: json(e) } });
      const issuer = issuers.find((i) => i.id === e.issuerId);
      await tx.action.create({
        data: { type: e.category, title: `${issuer?.name || 'Needs triage'} · ${e.summary}`, conferenceId: e.conferenceId, issuerId: e.issuerId, investorId: e.investorId, emailId: email.id, proposalId: proposal.id, assignedTo: issuer?.ownerId || user.id, priority: 'Normal', recommendation: 'Added by the reviewer from a sentence in the email.' },
      });
      const statuses = [...email.proposals.map((x) => x.status), 'Pending'];
      await tx.email.update({ where: { id: email.id }, data: { status: rollupEmailStatus(statuses) } });
      await audit(tx, user, 'Ask added from email sentence', 'Proposal', proposal.id, undefined, { emailId: email.id, issuerId: e.issuerId, note: p.text });
      return { ok: true, proposalId: proposal.id };
    });
  }
  if (type === 'exportMarkSent') {
    // Downloading is not sending: the latest download for this audience becomes the "sent" baseline.
    const p = z.object({ conferenceId: z.string(), scope: z.string(), audienceId: z.string().nullable().default(null) }).parse(input);
    const last = await db.exportLog.findFirst({ where: { conferenceId: p.conferenceId, scope: p.scope, audienceId: p.audienceId }, orderBy: { createdAt: 'desc' } });
    if (!last) throw new Error('Download the planner first, then mark it as sent.');
    await db.exportLog.update({ where: { id: last.id }, data: { sentAt: now() } });
    await db.auditLog.create({ data: { actorId: user.id, action: 'Planner marked as sent', entityType: 'ExportLog', entityId: last.id, note: `${p.scope}${p.audienceId ? ` · ${p.audienceId}` : ''}`, after: { meetings: last.meetingIds.length } } });
    return { ok: true, meetings: last.meetingIds.length };
  }
  if (type === 'ping') return { ok: true }; // lets the client refresh after a batch of direct calls
  if (type === 'markSeen') {
    // "What changed since my last visit" starts again from now.
    await db.user.update({ where: { id: user.id }, data: { lastSeenAt: new Date() } });
    return { ok: true };
  }
  if (type === 'bulkApprove') {
    // Approve several clean asks in one go. Each goes through the normal approval (same checks,
    // same audit); anything that needs a human judgement is skipped with the reason.
    banker(user);
    const p = z.object({ actionIds: z.array(z.string()).min(1).max(50) }).parse(input);
    await expirePast(); // items about a past time are never bulk-approved
    const results: { actionId: string; ok: boolean; reason?: string }[] = [];
    for (const actionId of p.actionIds) {
      const a = await db.action.findUnique({ where: { id: actionId } });
      const proposal = a?.proposalId ? await db.proposal.findUnique({ where: { id: a.proposalId }, include: { email: true } }) : null;
      const e = proposal ? extractionSchema.safeParse(proposal.extraction) : null;
      const why = !a || a.status !== 'Open'
        ? a?.status === 'Expired' ? 'The time has passed.' : 'Already handled.'
        : !proposal || !e?.success
          ? 'Not an email ask; open it to decide.'
          : proposal.status !== 'Pending'
            ? 'Already reviewed.'
            : proposal.email.escalation
              ? 'Escalation: needs a personal review.'
              : proposal.email.suspicious || !['verified', 'internal'].includes(proposal.email.senderStatus)
                ? 'Sender not verified.'
                : e.data.uncertainties.length
                  ? `Open question: ${e.data.uncertainties[0]}`
                  : e.data.conditional
                    ? 'Conditional ask: confirm the condition first.'
                    : e.data.operation === 'reschedule'
                      ? 'Move: needs the issuer and the investor to agree. Open it to record both consents.'
                      : '';
      if (why) {
        results.push({ actionId, ok: false, reason: why });
        continue;
      }
      try {
        await command(user, 'review', { id: proposal!.id, decision: 'approve', note: 'Bulk-approved from the queue' });
        results.push({ actionId, ok: true });
      } catch (err) {
        const raw = err instanceof Error && !/^Prisma/.test(err.name || err.constructor?.name || '');
        results.push({ actionId, ok: false, reason: raw ? (err as Error).message : 'Could not approve.' });
      }
    }
    return { approved: results.filter((r) => r.ok).length, results };
  }
  if (type === 'parseRequest') {
    const p = z.object({ text: z.string().min(3).max(500), conferenceId: z.string() }).parse(input);
    const c = await db.conference.findUniqueOrThrow({ where: { id: p.conferenceId } });
    const [issuers, investors] = await Promise.all([db.issuer.findMany(), db.investor.findMany()]);
    const parsed = parseRequestText(p.text, { conference: c, issuers, investors });
    const names = namesFrom(issuers, investors);
    // One option per issuer on the wish list. No time given: search the whole day (or event).
    const options = [];
    // Planned jointly: a time picked for one issuer is busy for the investor when placing the next.
    const planned: { start: Date; end: Date }[] = [];
    for (const issuerId of parsed.investorId ? parsed.issuerIds.slice(0, 8) : []) {
      const res = await resources(db, c.id, issuerId, parsed.investorId!);
      const windows = res.windows;
      const busy = [...res.busy, ...planned];
      const days = parsed.date ? [parsed.date] : eventDays(c);
      const winStart = parsed.windowStart ? conferenceTime(days[0], parsed.windowStart, c.timezone) : conferenceTime(days[0], '00:00', c.timezone);
      const winEnd = parsed.windowStart
        ? parsed.windowEnd
          ? conferenceTime(days[0], parsed.windowEnd, c.timezone)
          : addMinutes(winStart, parsed.duration)
        : conferenceTime(days[days.length - 1], '23:59', c.timezone);
      const open = availableSlots(windows, busy, parsed.duration, c.slotMinutes).find(
        (x) => +new Date(x.start) >= +winStart && +new Date(x.end) <= +winEnd,
      );
      const start = open ? new Date(open.start) : parsed.windowStart ? winStart : null;
      if (start) planned.push({ start, end: addMinutes(start, parsed.duration) });
      const proposal = start
        ? (() => {
            const slot = { start, end: addMinutes(start, parsed.duration) };
            return { start: slot.start.toISOString(), end: slot.end.toISOString(), ...evaluate(slot, windows, busy, parsed.duration, c.slotMinutes) };
          })()
        : null;
      // Duplicate warning: they already meet, or a request is already open.
      const [meeting, request] = await Promise.all([
        // Duplicate warnings are about this event only.
        db.meeting.findFirst({ where: { conferenceId: c.id, issuerId, investorId: parsed.investorId!, status: 'Confirmed' }, orderBy: { start: 'asc' } }),
        db.meetingRequest.findFirst({ where: { conferenceId: c.id, issuerId, investorId: parsed.investorId!, status: { notIn: ['Confirmed', 'Cancelled', 'Expired'] } } }),
      ]);
      const zone = c.timezone;
      const duplicate = meeting
        ? `${names.investor(parsed.investorId!)} already meets ${names.issuer(issuerId)} ${formatInTimeZone(meeting.start, zone, 'EEE h:mm a')}.`
        : request
          ? `A request for ${names.investor(parsed.investorId!)} × ${names.issuer(issuerId)} is already open (${formatInTimeZone(request.start, zone, 'EEE h:mm a')}).`
          : null;
      options.push({ issuerId, proposal, duplicate, searched: parsed.windowStart ? 'window' : parsed.date ? 'day' : 'event' });
    }
    return { parsed, proposal: options[0]?.proposal || null, options };
  }
  if (type.startsWith('meeting')) {
    const result = await meetingCommand(user, type, input);
    if (result !== undefined) return result;
  }
  const resourceResult = await handleResourceCommand(user, type, input);
  if (resourceResult !== undefined) return resourceResult;
  throw new Error('Unknown command.');
}
async function deliverDraft(
  tx: Tx,
  user: User,
  d: { id: string; meetingId: string | null; emailId: string | null },
  p: { to: string[]; cc: string[]; subject: string; body: string },
): Promise<{ mode: 'outlook' | 'simulated'; receipt: string }> {
  const token = await accessTokenFor(user.id);
  if (!token) return new SimulatedOutlook().deliver();
  if (d.meetingId) {
    const m = await tx.meeting.findUniqueOrThrow({ where: { id: d.meetingId } });
    const [c, i, v] = await Promise.all([
      tx.conference.findUniqueOrThrow({ where: { id: m.conferenceId } }),
      tx.issuer.findUniqueOrThrow({ where: { id: m.issuerId } }),
      tx.investor.findUniqueOrThrow({ where: { id: m.investorId } }),
    ]);
    await sendMail(token, {
      ...p,
      ics: { name: 'meeting.ics', text: meetingIcs(m, i.name, v.name, c) },
    });
    return { mode: 'outlook', receipt: `outlook:sendMail:${new Date().toISOString()}` };
  }
  const source = d.emailId ? await tx.email.findUnique({ where: { id: d.emailId } }) : null;
  if (source?.graphId) {
    await replyInThread(token, source.graphId, p);
    return { mode: 'outlook', receipt: `outlook:reply:${source.graphId}` };
  }
  await sendMail(token, p);
  return { mode: 'outlook', receipt: `outlook:sendMail:${new Date().toISOString()}` };
}
async function applyAvailability(
  tx: Tx,
  user: User,
  p: {
    start: string;
    end: string;
    conferenceId: string;
    issuerId: string;
    operation: string;
    kind: string;
    replaceConfirmed: boolean;
    sourceEmailId?: string;
  },
) {
  const where = { conferenceId: p.conferenceId, issuerId: p.issuerId };
  if (p.operation === 'replace') {
    if (!p.replaceConfirmed)
      throw new Error('Explicit confirmation required to replace availability.');
    await tx.availability.deleteMany({ where: { ...where, kind: 'Available' } });
  }
  if (p.kind !== 'Available' && p.operation !== 'remove') {
    const { busy } = await resources(tx, p.conferenceId, p.issuerId);
    if (busy.some((b) => overlaps(p, b)))
      throw new Error('Block or hold overlaps an existing meeting, block, or hold.');
  }
  if (p.operation === 'remove') {
    for (const w of await tx.availability.findMany({ where: { ...where, kind: 'Available' } }))
      if (overlaps(p, w)) {
        await tx.availability.delete({ where: { id: w.id } });
        if (+w.start < +new Date(p.start))
          await tx.availability.create({
            data: {
              ...where,
              start: w.start,
              end: new Date(p.start),
              kind: 'Available',
              approvedBy: user.id,
              sourceEmailId: w.sourceEmailId,
            },
          });
        if (+w.end > +new Date(p.end))
          await tx.availability.create({
            data: {
              ...where,
              start: new Date(p.end),
              end: w.end,
              kind: 'Available',
              approvedBy: user.id,
              sourceEmailId: w.sourceEmailId,
            },
          });
      }
  } else {
    let start = new Date(p.start),
      end = new Date(p.end);
    if (p.kind === 'Available') {
      const existing = await tx.availability.findMany({ where: { ...where, kind: 'Available' } });
      // "Narrow": the new window replaces that day's availability (meetings stay; refresh flags gaps).
      const tz = p.operation === 'narrow' ? (await tx.conference.findUniqueOrThrow({ where: { id: p.conferenceId } })).timezone : 'UTC';
      const day = (d: Date) => formatInTimeZone(d, tz, 'yyyy-MM-dd');
      const sameDay = (w: { start: Date }) => day(w.start) === day(start);
      const absorbed =
        p.operation === 'narrow'
          ? existing.filter((w) => overlaps(w, { start, end }) || sameDay(w))
          : existing.filter((w) => +w.start <= +end && +w.end >= +start); // overlapping or touching: extend
      for (const w of absorbed) {
        if (p.operation !== 'narrow') {
          start = new Date(Math.min(+start, +w.start));
          end = new Date(Math.max(+end, +w.end));
        }
        await tx.availability.delete({ where: { id: w.id } });
      }
    }
    await tx.availability.create({
      data: {
        ...where,
        start,
        end,
        kind: p.kind,
        approvedBy: user.id,
        sourceEmailId: p.sourceEmailId,
      },
    });
  }
  // Confirmed meetings are preserved; refresh() flags gaps after the entire update.
}
function eventDays(c: { startDate: string; endDate: string }) {
  const out: string[] = [];
  for (let d = new Date(`${c.startDate}T12:00:00Z`); d.toISOString().slice(0, 10) <= c.endDate; d = new Date(+d + 86400000)) out.push(d.toISOString().slice(0, 10));
  return out;
}
/** Manager dashboard across every event, from the live records. */
async function managerMetrics(conferenceId?: string) {
  const [conferences, issuers, investors, users, requests, meetings, coverage, proposals, actions, emails] = await Promise.all([
    db.conference.findMany(),
    db.issuer.findMany({ select: { id: true, name: true, contactEmail: true } }),
    db.investor.findMany({ select: { id: true, name: true } }),
    db.user.findMany({ select: { id: true, name: true, role: true } }),
    db.meetingRequest.findMany({ select: { id: true, conferenceId: true, issuerId: true, investorId: true, status: true, createdAt: true } }),
    db.meeting.findMany({ select: { id: true, conferenceId: true, issuerId: true, investorId: true, status: true, requestId: true, bankerIds: true, start: true, createdAt: true } }),
    db.meetingCoverageAssignment.findMany({ select: { meetingId: true, bankerId: true } }),
    db.proposal.findMany({ select: { status: true, editedOnReview: true, extraction: true, email: { select: { conferenceId: true, suspicious: true, status: true } } } }),
    db.action.findMany({ select: { id: true, type: true, status: true, assignedTo: true, createdAt: true, conferenceId: true, title: true } }),
    db.email.findMany({ select: { id: true, subject: true, sender: true, issuerId: true, conferenceId: true, status: true, receivedAt: true, escalation: true, source: true } }),
  ]);
  // Event picker: every list is narrowed to that event.
  const inEvent = <T extends { conferenceId: string | null }>(rows: T[]) => (conferenceId ? rows.filter((r) => r.conferenceId === conferenceId) : rows);
  return computeMetrics({
    now: now(),
    conferences: conferenceId ? conferences.filter((c) => c.id === conferenceId) : conferences,
    issuers,
    investors,
    users,
    requests: inEvent(requests),
    meetings: inEvent(meetings),
    coverage,
    proposals: inEvent(
      proposals.map((p) => ({
        status: p.status,
        editedOnReview: p.editedOnReview,
        conferenceId: p.email.conferenceId,
        noise: p.email.suspicious || p.email.status === 'Quarantined',
        category: String((p.extraction as { category?: string } | null)?.category || ''),
      })),
    ),
    actions: conferenceId ? actions.filter((a) => a.conferenceId === conferenceId || !a.conferenceId) : actions,
    emails: inEvent(emails),
  });
}
/** Investors a salesperson covers. */
async function clientIds(user: User) {
  if (user.role !== 'SALES') return [];
  return (await db.investor.findMany({ where: { coverageSalesId: user.id }, select: { id: true } })).map((x) => x.id);
}
/** Plain reason a request is not simply open: who already has the time, or the issuer's hours. */
function requestReason(
  r: { start: Date; end: Date; issuerId: string; investorId: string; status: string },
  busy: { start: Date; end: Date; issuerId?: string; investorId?: string; kind?: string }[],
  windows: { start: Date; end: Date }[],
  n: Names,
  zone: string,
) {
  if (['Confirmed', 'Cancelled'].includes(r.status)) return '';
  if (!windows.length) return `${n.issuer(r.issuerId)} has not sent availability yet.`;
  const clash = busy.find((b) => overlaps(b, r));
  if (clash && 'investorId' in clash && clash.issuerId && clash.investorId)
    return `${n.issuer(clash.issuerId)} already meets ${n.investor(clash.investorId)} ${formatInTimeZone(clash.start, zone, 'EEE h:mm a')}.`;
  if (clash) return `${n.issuer(r.issuerId)} marked that time as ${(clash.kind || 'blocked').toLowerCase()}.`;
  if (!isAvailable(r, windows, [])) return `Outside ${n.issuer(r.issuerId)}'s availability.`;
  return '';
}
/**
 * Queue items about a time that has passed expire: they stay visible (status "Expired", with a
 * Reopen) but leave every count. Requests and meeting alerts expire with their meeting time; email
 * asks when every time they propose (and the meeting they refer to) is in the past.
 */
export async function expirePast(at = now()) {
  const open = await db.action.findMany({ where: { status: 'Open' } });
  if (!open.length) return 0;
  const [requests, meetings, proposals] = await Promise.all([
    db.meetingRequest.findMany({ where: { id: { in: open.map((a) => a.requestId).filter(Boolean) as string[] } } }),
    db.meeting.findMany({ where: { id: { in: open.map((a) => a.meetingId).filter(Boolean) as string[] } } }),
    db.proposal.findMany({ where: { id: { in: open.map((a) => a.proposalId).filter(Boolean) as string[] }, status: 'Pending' } }),
  ]);
  const t = +at;
  const expired: { id: string; why: string; proposalId?: string | null; requestId?: string | null }[] = [];
  for (const a of open) {
    const r = requests.find((x) => x.id === a.requestId);
    if (r && !['Confirmed', 'Cancelled'].includes(r.status) && +r.start <= t) {
      expired.push({ id: a.id, why: 'The requested time has passed.', requestId: r.id });
      continue;
    }
    const m = meetings.find((x) => x.id === a.meetingId);
    if (m && !a.proposalId && +m.end <= t && !/escalation/i.test(a.type)) {
      expired.push({ id: a.id, why: 'The meeting already took place.' });
      continue;
    }
    const p = proposals.find((x) => x.id === a.proposalId);
    const e = p?.extraction as { operation?: string; windows?: { start: string; end: string; kind: string }[]; referenceTime?: string | null } | undefined;
    if (!p || !e || e.operation === 'escalate' || /escalation/i.test(a.type)) continue;
    const times = (e.windows || []).filter((w) => w.kind !== 'existingMeeting').map((w) => +new Date(w.end));
    const ref = e.referenceTime ? +new Date(e.referenceTime) : null;
    if (times.length && times.every((x) => x <= t) && (ref === null || ref <= t))
      expired.push({ id: a.id, why: 'Every time in this ask has passed.', proposalId: p.id });
  }
  for (const x of expired) {
    await db.action.update({ where: { id: x.id }, data: { status: 'Expired', recommendation: x.why } });
    if (x.proposalId) await db.proposal.update({ where: { id: x.proposalId }, data: { status: 'Expired', reviewNote: x.why } });
    if (x.requestId) await db.meetingRequest.update({ where: { id: x.requestId }, data: { status: 'Expired' } });
  }
  return expired.length;
}
export async function getState(user: User) {
  await expirePast();
  const resourceStatePromise = getResourceState(user);
  const clients = await clientIds(user);
  // Sales see their own requests and everything for the accounts they cover.
  const salesRequests = { OR: [{ salespersonId: user.id }, { investorId: { in: clients } }] };
  const [
    conferences,
    issuers,
    investors,
    users,
    availability,
    requests,
    meetings,
    emails,
    actions,
    drafts,
    auditLogs,
  ] = await Promise.all([
    db.conference.findMany(),
    db.issuer.findMany(),
    db.investor.findMany(),
    db.user.findMany(),
    db.availability.findMany(),
    db.meetingRequest.findMany({
      where: user.role === 'SALES' ? salesRequests : {},
      orderBy: { createdAt: 'desc' },
    }),
    db.meeting.findMany({
      where:
        user.role === 'SALES'
          ? { OR: [{ request: { salespersonId: user.id } }, { investorId: { in: clients } }] }
          : {},
      orderBy: { start: 'asc' },
    }),
    // Sales: "My emails" — emails they sent, forwarded, or were on.
    db.email.findMany({
      where:
        isDesk(user.role)
          ? {}
          : {
              OR: [
                { sender: { equals: user.email, mode: 'insensitive' } },
                { forwardedBy: { equals: user.email, mode: 'insensitive' } },
                { cc: { has: user.email } },
                { to: { has: user.email } },
              ],
            },
      include: { proposals: { orderBy: { askIndex: 'asc' } } },
      orderBy: { receivedAt: 'desc' },
    }),
    isDesk(user.role) ? db.action.findMany({ orderBy: { createdAt: 'desc' } }) : [],
    db.draft.findMany({
      where: isDesk(user.role) ? {} : { createdBy: user.id },
      orderBy: { createdAt: 'desc' },
    }),
    isDesk(user.role)
      ? db.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 100 })
      : [],
  ]);
  const names = namesFrom(issuers, investors);
  const computed = [];
  for (const r of requests) {
    const { windows, busy } = await resources(db, r.conferenceId, r.issuerId, r.investorId);
    const c = conferences.find((x) => x.id === r.conferenceId)!;
    const result = evaluate(r, windows, busy, r.duration, c.slotMinutes);
    // Alternatives across days: up to two per day, nearest to the requested time of day.
    const minuteOfDay = (d: Date | string) => {
      const [h, m] = formatInTimeZone(d, c.timezone, 'H:m').split(':').map(Number);
      return h * 60 + m;
    };
    const byDay = new Map<string, typeof result.alternatives>();
    for (const slot of availableSlots(windows, busy, r.duration, c.slotMinutes)
      .filter((x) => +new Date(x.start) !== +r.start)
      .sort((a, b) => Math.abs(minuteOfDay(a.start) - minuteOfDay(r.start)) - Math.abs(minuteOfDay(b.start) - minuteOfDay(r.start)))) {
      const day = formatInTimeZone(slot.start, c.timezone, 'yyyy-MM-dd');
      const list = byDay.get(day) || [];
      if (list.length < 2) byDay.set(day, [...list, slot]);
    }
    const alternatives = [...byDay.values()].flat().sort((a, b) => +new Date(a.start) - +new Date(b.start)).slice(0, 6);
    const status = ['Confirmed', 'Cancelled', 'Awaiting Banker Approval'].includes(r.status) ? r.status : result.status;
    computed.push({
      ...r,
      status,
      reason: requestReason({ ...r, status }, busy as never, windows, names, c.timezone),
      alternatives: ['Confirmed', 'Cancelled'].includes(r.status) ? [] : alternatives,
    });
  }
  const slots = [];
  for (const c of conferences)
    for (const i of issuers) {
      const { windows, busy } = await resources(db, c.id, i.id);
      slots.push({
        conferenceId: c.id,
        issuerId: i.id,
        slots: availableSlots(windows, busy, c.slotMinutes, c.slotMinutes),
      });
    }
  const resourceState = await resourceStatePromise;
  const outlook = isDesk(user.role) ? await outlookStatus(user.id) : null;
  const notifications = await db.notification.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 40,
  });
  // Sales see each ask's status and the reviewer's reason, not the raw extraction or flags.
  const visibleEmails =
    isDesk(user.role)
      ? emails
      : emails.map((e) => ({
          ...e,
          body: '',
          securityFlags: [],
          proposals: e.proposals.map((x) => ({ ...x, extraction: {} as Prisma.JsonValue, reviewNote: x.reviewNote })),
        }));
  return {
    user,
    outlook,
    conferences,
    issuers: issuers.map((i) =>
      isDesk(user.role)
        ? i
        : { id: i.id, name: i.name, sector: i.sector, color: i.color, ownerId: i.ownerId },
    ),
    investors: investors.map((i) => ({ id: i.id, name: i.name, coverageSalesId: i.coverageSalesId })),
    clients,
    notifications,
    users: users.map((u) => ({ id: u.id, name: u.name, role: u.role, email: u.email })),
    /** Recipient allowlist (registered issuer/investor domains + internal) for draft warnings. */
    allowedDomains:
      isDesk(user.role)
        ? [...new Set([...issuers, ...investors].map((p) => domainOf(p.contactEmail)).concat(internalDomains()))]
        : [],
    internalDomains: isDesk(user.role) ? internalDomains() : [],
    availability:
      isDesk(user.role)
        ? availability
        : availability.map((a) => ({
            id: a.id,
            conferenceId: a.conferenceId,
            issuerId: a.issuerId,
            start: a.start,
            end: a.end,
            kind: a.kind,
            updatedAt: a.updatedAt,
          })),
    requests: computed,
    meetings,
    emails: visibleEmails,
    actions,
    drafts,
    auditLogs,
    slots,
    ...resourceState,
    metrics: user.role === 'MANAGER' ? await managerMetrics() : null,
    now: now().toISOString(),
    parser: process.env.LLM_API_KEY ? 'Configured LLM (rule parser when unreachable)' : 'Deterministic mock',
    demo: process.env.DEMO_MODE === 'true',
  };
}
