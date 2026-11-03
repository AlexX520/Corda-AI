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
import { namedContext } from './rule-parser';
import { availableSlots, conferenceTime, evaluate, isAvailable, overlaps, validateInterval } from './scheduling';
import {
  domainOf,
  finalizeAsks,
  internalDomains,
  resolveConference,
  securityFlags,
  senderTrust,
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
  clarificationBody,
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
  await tx.auditLog.create({
    data: {
      actorId: user.id,
      action,
      entityType,
      entityId,
      ...(before ? { before: json(before) } : {}),
      ...(after ? { after: json(after) } : {}),
    },
  });
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
  return {
    windows: availability.filter((a) => a.kind === 'Available'),
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
async function makeConfirmationDraft(tx: Tx, user: User, meetingId: string) {
  const m = await tx.meeting.findUniqueOrThrow({ where: { id: meetingId } }),
    c = await tx.conference.findUniqueOrThrow({ where: { id: m.conferenceId } }),
    i = await tx.issuer.findUniqueOrThrow({ where: { id: m.issuerId } }),
    v = await tx.investor.findUniqueOrThrow({ where: { id: m.investorId } });
  const email = m.sourceEmailId
    ? await tx.email.findUnique({ where: { id: m.sourceEmailId } })
    : null;
  // Recipients are never pre-filled: everyone on the chain is offered as a suggestion and the
  // banker adds them deliberately (see "Contacts to review" in the draft editor).
  const chain = email ? [email.sender, ...email.to, ...email.cc] : [];
  return tx.draft.create({
    data: {
      meetingId: m.id,
      emailId: email?.id,
      createdBy: user.id,
      sender: user.email,
      to: [],
      cc: [],
      historicalParticipants: [...new Set([i.contactEmail, v.contactEmail, ...chain])],
      subject: `${c.name} | ${i.name} × ${v.name} — meeting confirmation`,
      body: `Hello,\n\nYour meeting is confirmed for ${formatInTimeZone(m.start, c.timezone, 'EEEE, MMMM d, h:mm a')}–${formatInTimeZone(m.end, c.timezone, 'h:mm a')} (${c.timezone}).\n\nIssuer: ${i.name}\nInvestor: ${v.name}\nLocation: ${m.location || 'To be confirmed'}\n\nA meeting-specific calendar attachment will accompany this draft.\n\nBest regards,\n${user.name}`,
    },
  });
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
/** Read an email into reviewable asks: sender check, event, parsing, escalation and meeting match. */
async function analyseEmail(p: IngestInput) {
  const [conferences, issuers, investors, users] = await Promise.all([
    db.conference.findMany(),
    db.issuer.findMany(),
    db.investor.findMany(),
    db.user.findMany(),
  ]);
  const ctx = { conferences, issuers, investors };
  const trust = senderTrust(p.sender, { issuers, investors, internal: internalDomains() });
  const content = newEmailContent(p.body);
  const names = namesFrom(issuers, investors);
  // Which event: named in the email, else the only event of the sender's company (or the company
  // the email names), else the only active event — and say that it was assumed.
  let defaultConferenceId: string | null = null,
    contextNote = '';
  const named = namedContext(p.body, p.subject, ctx);
  if (!p.conferenceId && !named.conferenceId) {
    const issuerIds = trust.issuerId ? [trust.issuerId] : trust.investorId ? [] : named.issuerIds.slice(0, 1);
    const investorIds = trust.investorId ? [trust.investorId] : trust.issuerId ? [] : issuerIds.length ? [] : named.investorIds.slice(0, 1);
    const resolved = resolveConference({
      conferences,
      involved: await involvement(issuerIds, investorIds),
      entityName: issuerIds.length ? names.issuer(issuerIds[0]) : investorIds.length ? names.investor(investorIds[0]) : null,
      today: new Date().toISOString().slice(0, 10),
    });
    defaultConferenceId = resolved.conferenceId;
    contextNote = resolved.note;
  }
  const extracted = await extractEmail(p.body, p.subject, ctx, {
    conferenceId: p.conferenceId,
    issuerId: p.issuerId,
    defaultConferenceId,
    senderIssuerId: trust.status === 'unverified' ? null : trust.issuerId,
    senderInvestorId: trust.status === 'unverified' ? null : trust.investorId,
    receivedAt: p.receivedAt || new Date().toISOString(),
  });
  for (const e of extracted.asks)
    if (
      (e.conferenceId && !conferences.some((c) => c.id === e.conferenceId)) ||
      (e.issuerId && !issuers.some((i) => i.id === e.issuerId)) ||
      (e.investorId && !investors.some((i) => i.id === e.investorId))
    )
      throw new Error('Unknown extracted association.');
  const zoneOf = (id: string | null) => conferences.find((c) => c.id === id)?.timezone || 'America/New_York';
  const asks = finalizeAsks(extracted.asks, {
    subject: p.subject,
    content,
    trust,
    names,
    zone: zoneOf(extracted.asks[0]?.conferenceId || defaultConferenceId),
  });
  // Suggest the affected meeting only when the rules allow it (see findCandidates).
  const meetings = await db.meeting.findMany({ where: { status: 'Confirmed' } });
  const trusted = trust.status !== 'unverified';
  for (const e of asks) {
    if (!['cancel', 'reschedule'].includes(e.operation)) continue;
    const r = findCandidates(e, meetings, { zone: zoneOf(e.conferenceId), trusted, open: isOpenMeeting, n: names });
    e.meetingId = r.preselectId;
    if (!r.preselectId && trusted && e.issuerId && !e.missing.includes('meeting')) e.missing.push('meeting');
  }
  const flags = securityFlags(p.subject, p.body);
  if (trust.status === 'unverified')
    flags.unshift(
      trust.lookalikeOf
        ? `Sender not verified: ${trust.domain} looks like ${trust.lookalikeOf} but is not the registered domain.`
        : `Sender not verified: ${trust.domain} is not a registered issuer, investor or bank domain.`,
    );
  const addressed = users.find(
    (u) => u.role === 'BANKER' && p.to.some((t) => t.toLowerCase() === u.email.toLowerCase()),
  );
  return { asks, trust, flags, contextNote, content, issuers, addressed, parser: extracted.parser };
}
type Analysis = Awaited<ReturnType<typeof analyseEmail>>;
/** One proposal and one queue action per ask. */
async function writeAsks(tx: Tx, emailId: string, a: Analysis) {
  for (const [askIndex, e] of a.asks.filter((x) => x.needsReview).entries()) {
    const proposal = await tx.proposal.create({
      data: { emailId, askIndex, summary: e.summary, extraction: json(e) },
    });
    const issuer = a.issuers.find((i) => i.id === e.issuerId);
    const escalation = e.category === 'Escalation / complaint';
    const owner = escalation ? a.addressed?.id || issuer?.ownerId : issuer?.ownerId;
    const doubts = e.uncertainties.filter((u) => !u.startsWith(SELECT_UNCERTAINTY));
    const trusted = a.trust.status !== 'unverified';
    await tx.action.create({
      data: {
        type: e.category,
        title: `${issuer?.name || 'Needs triage'} · ${e.summary}`,
        conferenceId: e.conferenceId,
        issuerId: e.issuerId,
        investorId: e.investorId,
        emailId,
        proposalId: proposal.id,
        meetingId: e.meetingId,
        assignedTo: owner || null,
        ccUserIds: escalation && issuer?.ownerId && issuer.ownerId !== owner ? [issuer.ownerId] : [],
        priority: escalation ? 'Urgent' : !trusted || doubts.length ? 'High' : 'Normal',
        recommendation: escalation
          ? 'Acknowledge, assign one owner and reply to the client today.'
          : !trusted
            ? 'Sender not verified — confirm with the registered contact before acting.'
            : doubts.length
              ? 'Resolve uncertainty and review proposed changes'
              : 'Review source evidence and approve changes',
      },
    });
  }
}
const emailFields = (a: Analysis) => {
  const first = a.asks[0];
  const categories = [...new Set(a.asks.map((x) => x.category))];
  return {
    conferenceId: first.conferenceId,
    issuerId: first.issuerId,
    investorId: a.asks.length === 1 ? first.investorId : null,
    category: categories.length > 1 ? 'Multiple asks' : first.category,
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
    await writeAsks(tx, mail.id, a);
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
  const p = z.object({ emailId: z.string(), conferenceId: z.string() }).parse(input);
  const email = await db.email.findUniqueOrThrow({ where: { id: p.emailId }, include: { proposals: true } });
  if (email.proposals.some((x) => x.status !== 'Pending'))
    throw new Error('Some asks were already decided; correct the event on each remaining ask instead.');
  const conference = await db.conference.findUniqueOrThrow({ where: { id: p.conferenceId } });
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
    conferenceId: conference.id,
  });
  a.contextNote = `Event set to ${conference.name} by ${user.name}.`;
  return db.$transaction(async (tx) => {
    await tx.action.deleteMany({ where: { emailId: email.id, status: 'Open' } });
    await tx.proposal.deleteMany({ where: { emailId: email.id } });
    await tx.email.update({ where: { id: email.id }, data: emailFields(a) });
    await writeAsks(tx, email.id, a);
    await audit(tx, user, 'Email event set', 'Email', email.id, { conferenceId: email.conferenceId, asks: email.proposals.map((x) => x.extraction) }, { conferenceId: conference.id, asks: a.asks });
    return { ok: true };
  });
}

/* ------------------------------------------------------------------ manual meeting control */

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
      .extend({ id: z.string(), reason: z.string().trim().min(3, 'Give a reason for the change.').max(500), override: z.boolean().default(false) })
      .parse(input);
    return db.$transaction(async (tx) => {
      await lock(tx);
      const m = await tx.meeting.findUniqueOrThrow({ where: { id: p.id } });
      if (m.status !== 'Confirmed') throw new Error('Only confirmed meetings can be edited.');
      const c = await tx.conference.findUniqueOrThrow({ where: { id: m.conferenceId } });
      const start = conferenceTime(p.date, p.time, c.timezone),
        end = addMinutes(start, p.duration);
      const check = await slotCheck(tx, { ...m, id: m.id, start, end, bankerIds: p.bankerIds, attendees: p.attendees, cubeId: p.cubeId });
      if (check.hard.length) throw new Error(check.hard.join(' '));
      if (check.soft.length && !p.override) throw new Error(`${check.soft.join(' ')} Tick "Schedule anyway" to keep it.`);
      const cube = p.cubeId ? await tx.meetingCube.findUnique({ where: { id: p.cubeId } }) : null;
      const location = p.location.trim() || (cube ? cube.location : p.cubeId === null ? '' : m.location);
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
      await audit(tx, user, `Meeting edited (${changed.join(', ') || 'no change'})`, 'Meeting', m.id, before, {
        ...updated,
        coverage: p.bankerIds,
        cubeId: p.cubeId,
        reason: p.reason,
        overrides: p.override ? check.soft : [],
      });
      await refresh(tx, m.conferenceId);
      return updated;
    });
  }
  if (type === 'meetingCancel') {
    const p = z.object({ id: z.string(), reason: z.string().trim().min(3, 'A reason is required to cancel.').max(500) }).parse(input);
    return db.$transaction(async (tx) => {
      await lock(tx);
      const m = await tx.meeting.findUniqueOrThrow({ where: { id: p.id } });
      if (m.status === 'Cancelled') throw new Error('Meeting already cancelled.');
      const updated = await tx.meeting.update({ where: { id: m.id }, data: { status: 'Cancelled' } });
      if (m.requestId) await tx.meetingRequest.update({ where: { id: m.requestId }, data: { status: 'Cancelled' } });
      await tx.draft.updateMany({ where: { meetingId: m.id, status: 'Draft' }, data: { status: 'Superseded' } });
      await tx.action.updateMany({ where: { meetingId: m.id, status: 'Open' }, data: { status: 'Resolved' } });
      await audit(tx, user, 'Meeting cancelled', 'Meeting', m.id, m, { ...updated, reason: p.reason });
      await refresh(tx, m.conferenceId);
      return updated;
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
          location: p.location.trim() || (cube ? cube.location : ''),
          bankerIds: p.bankerIds,
          approvedRecipients: [],
          approvedBy: user.id,
          expectedAttendees: p.attendees,
        },
      });
      await tx.meetingCoverageRequirement.create({ data: { meetingId: m.id, requiredBankerCount: 2, requiredPrimaryCount: 1 } });
      await assignResources(tx, user, m.id, p.bankerIds, p.cubeId);
      await makeConfirmationDraft(tx, user, m.id);
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
      if (user.role !== 'BANKER' && r.salespersonId !== user.id) throw new Error('Forbidden');
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
        operation: z.enum(['add', 'replace', 'remove']).default('add'),
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
        decision: z.enum(['approve', 'reject', 'clarify', 'edit', 'acknowledge']),
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
      })
      .parse(input);
    return db.$transaction(async (tx) => {
      await lock(tx);
      const proposal = await tx.proposal.findUniqueOrThrow({
        where: { id: p.id },
        include: { email: true },
      });
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
        if (!owner || owner.role !== 'BANKER') throw new Error('Pick the banker who owns the follow-up.');
        await tx.proposal.update({
          where: { id: p.id },
          data: { status: 'Acknowledged', reviewerId: user.id, reviewNote: p.note, extraction: json(e) },
        });
        await tx.action.updateMany({
          where: actionScope,
          data: {
            assignedTo: owner.id,
            status: 'Open',
            priority: 'Urgent',
            recommendation: `Acknowledged by ${user.name}. ${owner.name} owns the follow-up${p.note.trim() ? `: ${p.note.trim()}` : '.'}`,
          },
        });
        const statuses = (await tx.proposal.findMany({ where: { emailId: email.id } })).map((x) => x.status);
        await tx.email.update({ where: { id: email.id }, data: { status: rollupEmailStatus(statuses) } });
        await audit(tx, user, 'Escalation acknowledged', 'Proposal', p.id, { status: proposal.status }, { owner: owner.id, note: p.note });
        return { ok: true };
      }
      if (p.decision === 'approve') {
        if (e.category === 'Escalation / complaint')
          throw new Error('Escalations are acknowledged and assigned to an owner, not approved.');
        if (email.senderStatus === 'unverified' && (!p.senderOverride || p.note.trim().length < 10))
          throw new Error('Sender not verified. Type why you trust this email (at least 10 characters) before approving.');
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
          const w = windows[0];
          validateInterval(w, c);
          const duration = (+new Date(w.end) - +new Date(w.start)) / 60000;
          if (duration < 15 || duration > 180)
            throw new Error('Requested duration must be between 15 and 180 minutes.');
          const [existingMeetings, existingRequests] = await Promise.all([
            tx.meeting.findMany({ where: { conferenceId: c.id, issuerId: e.issuerId, investorId: e.investorId } }),
            tx.meetingRequest.findMany({ where: { conferenceId: c.id, issuerId: e.issuerId, investorId: e.investorId } }),
          ]);
          const dupes = duplicatesFor(e, existingMeetings, existingRequests);
          if (dupes.length && !p.duplicateConfirmed)
            throw new Error(
              `${names.investor(e.investorId)} already has ${dupes.length === 1 ? 'a meeting or request' : `${dupes.length} meetings or requests`} with ${names.issuer(e.issuerId)}. Confirm this is an additional meeting to continue.`,
            );
          const issuer = await tx.issuer.findUniqueOrThrow({ where: { id: e.issuerId } });
          const resourcesForRequest = await resources(tx, c.id, e.issuerId, e.investorId);
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
          for (const w of windows)
            await applyAvailability(tx, user, {
              ...w,
              conferenceId: c.id,
              issuerId: e.issuerId,
              operation: e.operation === 'replace' ? 'add' : (e.operation as 'add' | 'remove'),
              kind: e.tentative ? 'Hold' : 'Available',
              replaceConfirmed: p.replaceConfirmed,
              sourceEmailId: proposal.emailId,
            });
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
          await confirmRequest(tx, user, p.requestId, '', proposal.emailId);
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
          await audit(
            tx,
            user,
            e.operation === 'cancel' ? 'Meeting cancelled from email' : 'Meeting moved from email',
            'Meeting',
            m.id,
            m,
            { ...(await tx.meeting.findUnique({ where: { id: m.id } })), sourceEmailId: email.id, reason: p.note },
          );
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
        data: { status, extraction: json(e), summary: e.summary, reviewerId: user.id, reviewNote: p.note },
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
      if (p.decision === 'clarify') {
        // A short, human question about the missing fact. Internal notes and parser
        // diagnostics never go into a client email.
        const trust = senderTrust(email.sender, { issuers, investors, internal: internalDomains() });
        const meetings = await tx.meeting.findMany({ where: { status: 'Confirmed' } });
        const pick =
          ['cancel', 'reschedule'].includes(e.operation) && !e.meetingId
            ? findCandidates(e, meetings, { zone: zone || 'America/New_York', trusted: true, open: isOpenMeeting, n: names })
            : null;
        const questions = clientQuestions(
          e,
          {
            issuer: e.issuerId ? names.issuer(e.issuerId) : null,
            investor: e.investorId ? names.investor(e.investorId) : null,
            conference: conferences.find((c) => c.id === e.conferenceId)?.name || null,
          },
          trust.issuerId ? 'issuer' : trust.investorId ? 'investor' : 'other',
          zone,
          pick && !pick.preselectId ? ['meeting'] : [],
        );
        const allowed = await allowedDomains(tx);
        const external = trust.status === 'verified';
        const cc = external
          ? email.cc.filter((x) => x.toLowerCase() !== user.email.toLowerCase() && !outsideAllowlist([x], allowed).length)
          : [];
        await tx.draft.create({
          data: {
            emailId: proposal.emailId,
            createdBy: user.id,
            sender: user.email,
            to: external ? [email.sender] : [],
            cc,
            historicalParticipants: [...new Set([email.sender, ...email.to, ...email.cc])].filter(
              (x) => x.toLowerCase() !== user.email.toLowerCase() && !(external && (x === email.sender || cc.includes(x))),
            ),
            subject: replySubject(email.subject),
            body: clarificationBody(questions, user.name),
          },
        });
      }
      await audit(tx, user, `Ask ${status.toLowerCase()}`, 'Proposal', p.id, { status: proposal.status, extraction: proposal.extraction }, {
        extraction: e,
        note: p.note,
        emailId: email.id,
      });
      return { ok: true };
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
      if (user.role !== 'BANKER' && r.salespersonId !== user.id) throw new Error('Forbidden');
      if (r.status === 'Confirmed')
        throw new Error('Confirmed meetings require a banker-reviewed cancellation email.');
      await tx.meetingRequest.update({ where: { id: r.id }, data: { status: 'Cancelled' } });
      await tx.action.updateMany({ where: { requestId: r.id }, data: { status: 'Resolved' } });
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
    if (user.role !== 'BANKER' && r.salespersonId !== user.id) throw new Error('Forbidden');
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
        /** Confirmation that possible deal / MNPI terms in the body are intended. */
        sensitiveConfirmed: z.boolean().default(false),
      })
      .parse(input);
    return db.$transaction(async (tx) => {
      await lock(tx);
      const d = await tx.draft.findUniqueOrThrow({ where: { id: p.id } });
      if (user.role !== 'BANKER' && d.createdBy !== user.id) throw new Error('Forbidden');
      if (d.status !== 'Draft') throw new Error('This draft is no longer editable.');
      if (p.send) {
        banker(user);
        if (!p.recipientsApproved || !p.to.length)
          throw new Error('Review and approve at least one recipient.');
        const outside = outsideAllowlist([...p.to, ...p.cc], await allowedDomains(tx));
        if (outside.length && !p.outsideConfirmed)
          throw new Error(
            `${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} outside the registered issuer, investor and bank domains. Confirm to send anyway.`,
          );
        const sensitive = findSensitive(`${p.subject}\n${p.body}`);
        if (sensitive.length && !p.sensitiveConfirmed)
          throw new Error(`The draft contains possible deal / MNPI terms (${sensitive.join(', ')}). Remove them or confirm.`);
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
        updated,
      );
      return updated;
    }, { timeout: 30000, maxWait: 10000 });
  }
  if (type === 'parseRequest') {
    const p = z.object({ text: z.string().min(3).max(500), conferenceId: z.string() }).parse(input);
    const c = await db.conference.findUniqueOrThrow({ where: { id: p.conferenceId } });
    const [issuers, investors] = await Promise.all([db.issuer.findMany(), db.investor.findMany()]);
    const parsed = parseRequestText(p.text, { conference: c, issuers, investors });
    let proposal: { start: string; end: string; status: string; alternatives: { start: Date | string; end: Date | string }[] } | null = null;
    if (parsed.issuerId && parsed.investorId && parsed.date && parsed.windowStart) {
      const { windows, busy } = await resources(db, c.id, parsed.issuerId, parsed.investorId);
      const winStart = conferenceTime(parsed.date, parsed.windowStart, c.timezone);
      const winEnd = parsed.windowEnd
        ? conferenceTime(parsed.date, parsed.windowEnd, c.timezone)
        : addMinutes(winStart, parsed.duration);
      // Best slot = first open slot inside the window the sales person asked for.
      const inWindow = availableSlots(windows, busy, parsed.duration, c.slotMinutes).find(
        (s) => +new Date(s.start) >= +winStart && +new Date(s.end) <= +winEnd,
      );
      const start = inWindow ? new Date(inWindow.start) : winStart;
      const slot = { start, end: addMinutes(start, parsed.duration) };
      const result = evaluate(slot, windows, busy, parsed.duration, c.slotMinutes);
      proposal = { start: slot.start.toISOString(), end: slot.end.toISOString(), ...result };
    }
    return { parsed, proposal };
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
  } else
    await tx.availability.create({
      data: {
        ...where,
        start: new Date(p.start),
        end: new Date(p.end),
        kind: p.kind,
        approvedBy: user.id,
        sourceEmailId: p.sourceEmailId,
      },
    });
  // Confirmed meetings are preserved; refresh() flags gaps after the entire update.
}
export async function getState(user: User) {
  const resourceStatePromise = getResourceState(user);
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
      where: user.role === 'SALES' ? { salespersonId: user.id } : {},
      orderBy: { createdAt: 'desc' },
    }),
    db.meeting.findMany({
      where: user.role === 'SALES' ? { request: { salespersonId: user.id } } : {},
      orderBy: { start: 'asc' },
    }),
    user.role === 'BANKER'
      ? db.email.findMany({
          include: { proposals: { orderBy: { askIndex: 'asc' } } },
          orderBy: { receivedAt: 'desc' },
        })
      : [],
    user.role === 'BANKER' ? db.action.findMany({ orderBy: { createdAt: 'desc' } }) : [],
    db.draft.findMany({
      where: user.role === 'BANKER' ? {} : { createdBy: user.id },
      orderBy: { createdAt: 'desc' },
    }),
    user.role === 'BANKER'
      ? db.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 100 })
      : [],
  ]);
  const computed = [];
  for (const r of requests) {
    const { windows, busy } = await resources(db, r.conferenceId, r.issuerId, r.investorId);
    const result = evaluate(
      r,
      windows,
      busy,
      r.duration,
      conferences.find((c) => c.id === r.conferenceId)!.slotMinutes,
    );
    computed.push({
      ...r,
      status: ['Confirmed', 'Cancelled', 'Awaiting Banker Approval'].includes(r.status)
        ? r.status
        : result.status,
      alternatives: ['Confirmed', 'Cancelled'].includes(r.status) ? [] : result.alternatives,
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
  const outlook = user.role === 'BANKER' ? await outlookStatus(user.id) : null;
  return {
    user,
    outlook,
    conferences,
    issuers: issuers.map((i) =>
      user.role === 'BANKER'
        ? i
        : { id: i.id, name: i.name, sector: i.sector, color: i.color, ownerId: i.ownerId },
    ),
    investors: investors.map((i) => ({ id: i.id, name: i.name })),
    users: users.map((u) => ({ id: u.id, name: u.name, role: u.role })),
    /** Recipient allowlist (registered issuer/investor domains + internal) for draft warnings. */
    allowedDomains:
      user.role === 'BANKER'
        ? [...new Set([...issuers, ...investors].map((p) => domainOf(p.contactEmail)).concat(internalDomains()))]
        : [],
    internalDomains: user.role === 'BANKER' ? internalDomains() : [],
    availability:
      user.role === 'BANKER'
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
    emails,
    actions,
    drafts,
    auditLogs,
    slots,
    ...resourceState,
    parser: process.env.LLM_API_KEY ? 'Configured LLM' : 'Deterministic mock',
    demo: process.env.DEMO_MODE === 'true',
  };
}
