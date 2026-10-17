import { Prisma, User } from '@prisma/client';
import { z } from 'zod';
import { addMinutes } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { db } from './db';
import { banker } from './auth';
import { extractEmail, extractionSchema, newEmailContent, generateDraft } from './extraction';
import { availableSlots, evaluate, isAvailable, overlaps, validateInterval } from './scheduling';
import { SimulatedOutlook } from './outlook';
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
  for (const m of await tx.meeting.findMany({ where: { conferenceId, status: 'Confirmed' } })) {
    const windows = await tx.availability.findMany({
      where: { conferenceId, issuerId: m.issuerId, kind: 'Available' },
    });
    const title = `Confirmed meeting outside availability · ${m.id}`;
    if (!isAvailable(m, windows, [])) {
      if (!(await tx.action.findFirst({ where: { title, status: 'Open' } }))) {
        const issuer = await tx.issuer.findUniqueOrThrow({ where: { id: m.issuerId } });
        await tx.action.create({
          data: {
            conferenceId,
            issuerId: m.issuerId,
            type: 'Availability conflict',
            title,
            assignedTo: issuer.ownerId,
            priority: 'Urgent',
            recommendation:
              'Confirmed meeting preserved. Obtain consent before rescheduling or cancelling.',
          },
        });
      }
    } else
      await tx.action.updateMany({
        where: { title, status: 'Open' },
        data: { status: 'Resolved' },
      });
  }
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
  return tx.draft.create({
    data: {
      meetingId: m.id,
      createdBy: user.id,
      sender: user.email,
      to: [],
      cc: [],
      historicalParticipants: [
        ...new Set([
          i.contactEmail,
          v.contactEmail,
          ...(email ? [email.sender, ...email.to, ...email.cc] : []),
        ]),
      ],
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
      sourceEmailId,
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
const intervalSchema = z.object({ start: z.string().datetime(), end: z.string().datetime() });
const requestSchema = intervalSchema.extend({
  conferenceId: z.string(),
  issuerId: z.string(),
  investorId: z.string(),
  duration: z.number().int().min(15).max(180),
  notes: z.string().max(4000).default(''),
  priority: z.enum(['Normal', 'High', 'Urgent']).default('Normal'),
  alternativeDates: z.array(z.string()).default([]),
});
export async function command(user: User, type: string, input: unknown): Promise<unknown> {
  if (type === 'ingest') {
    banker(user);
    const p = z
      .object({
        messageId: z.string().min(1).max(200),
        threadId: z.string().min(1).max(200),
        sender: z.string().email(),
        to: z.array(z.string().email()),
        cc: z.array(z.string().email()).default([]),
        subject: z.string().min(1).max(500),
        body: z.string().min(1).max(50000),
        conferenceId: z.string().optional(),
        issuerId: z.string().optional(),
      })
      .parse(input);
    if (await db.email.findUnique({ where: { messageId: p.messageId } }))
      throw new Error('This message has already been ingested.');
    const ctx = {
      conferences: await db.conference.findMany(),
      issuers: await db.issuer.findMany(),
      investors: await db.investor.findMany(),
    };
    const e = await extractEmail(p.body, p.subject, ctx, p);
    if (
      e.conferenceId &&
      e.issuerId &&
      e.investorId &&
      ['cancel', 'reschedule'].includes(e.operation)
    ) {
      const candidates = await db.meeting.findMany({
        where: {
          conferenceId: e.conferenceId,
          issuerId: e.issuerId,
          investorId: e.investorId,
          status: 'Confirmed',
        },
      });
      if (candidates.length === 1) e.meetingId = candidates[0].id;
    }
    if (
      (e.conferenceId && !ctx.conferences.some((c) => c.id === e.conferenceId)) ||
      (e.issuerId && !ctx.issuers.some((i) => i.id === e.issuerId)) ||
      (e.investorId && !ctx.investors.some((i) => i.id === e.investorId))
    )
      throw new Error('Unknown extracted association.');
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
          newContent: newEmailContent(p.body),
          conferenceId: e.conferenceId,
          issuerId: e.issuerId,
          investorId: e.investorId,
          category: e.category,
          status: e.needsReview ? 'Pending review' : 'Ignored',
        },
      });
      if (e.needsReview) {
        await tx.proposal.create({ data: { emailId: mail.id, extraction: json(e) } });
        await tx.action.create({
          data: {
            type: e.category,
            title: `${ctx.issuers.find((i) => i.id === e.issuerId)?.name || 'Unassociated email'} · ${e.category.toLowerCase()}`,
            conferenceId: e.conferenceId,
            issuerId: e.issuerId,
            investorId: e.investorId,
            emailId: mail.id,
            assignedTo: ctx.issuers.find((i) => i.id === e.issuerId)?.ownerId,
            priority: e.uncertainties.length ? 'High' : 'Normal',
            recommendation: e.uncertainties.length
              ? 'Resolve uncertainty and review proposed changes'
              : 'Review source evidence and approve changes',
          },
        });
      }
      await audit(tx, user, 'Email ingested', 'Email', mail.id, undefined, e);
      return mail;
    });
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
      const { windows, busy } = await resources(tx, p.conferenceId, p.issuerId, p.investorId);
      const result = evaluate(p, windows, busy, p.duration, c.slotMinutes);
      const r = await tx.meetingRequest.create({
        data: {
          ...p,
          start: new Date(p.start),
          end: new Date(p.end),
          salespersonId: user.id,
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
        decision: z.enum(['approve', 'reject', 'clarify', 'edit']),
        extraction: extractionSchema.optional(),
        note: z.string().default(''),
        uncertaintyResolved: z.boolean().default(false),
        replaceConfirmed: z.boolean().default(false),
        requestId: z.string().optional(),
        meetingId: z.string().optional(),
        consent: z.boolean().default(false),
      })
      .parse(input);
    return db.$transaction(async (tx) => {
      await lock(tx);
      const proposal = await tx.proposal.findUniqueOrThrow({
        where: { id: p.id },
        include: { email: true },
      });
      if (!['Pending', 'Clarification requested'].includes(proposal.status))
        throw new Error('Proposal has already been reviewed.');
      const e = p.extraction || extractionSchema.parse(proposal.extraction);
      if (p.decision === 'edit') {
        await tx.proposal.update({
          where: { id: p.id },
          data: { extraction: json(e), reviewNote: p.note, reviewerId: user.id },
        });
        await audit(tx, user, 'Proposal edited', 'Proposal', p.id, proposal.extraction, e);
        return { ok: true };
      }
      if (p.decision === 'approve') {
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
          const issuer = await tx.issuer.findUniqueOrThrow({ where: { id: e.issuerId } });
          const resourcesForRequest = await resources(tx, c.id, e.issuerId, e.investorId);
          const request = await tx.meetingRequest.create({
            data: {
              conferenceId: c.id,
              issuerId: e.issuerId,
              investorId: e.investorId,
              salespersonId: user.id,
              bankerId: issuer.ownerId,
              start: new Date(w.start),
              end: new Date(w.end),
              duration,
              alternativeDates: [],
              notes: `Approved email request: ${proposal.email.subject}`,
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
            request,
          );
        } else if (e.operation === 'inquiry')
          throw new Error(
            'This inquiry has no schedule change. Request clarification or resolve the action.',
          );
        else if (['add', 'remove', 'replace'].includes(e.operation)) {
          const windows = e.windows.filter((w) => w.kind === 'availability');
          if (!windows.length) throw new Error('Add an explicit verified time window first.');
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
        data: { status, extraction: json(e), reviewerId: user.id, reviewNote: p.note },
      });
      await tx.email.update({ where: { id: proposal.emailId }, data: { status } });
      await tx.action.updateMany({
        where: { emailId: proposal.emailId },
        data: {
          status: p.decision === 'clarify' ? 'Open' : 'Resolved',
          recommendation:
            p.decision === 'clarify'
              ? 'Review clarification draft and follow up'
              : 'Review completed',
        },
      });
      if (p.decision === 'clarify')
        await tx.draft.create({
          data: {
            emailId: proposal.emailId,
            createdBy: user.id,
            sender: user.email,
            to: [proposal.email.sender],
            cc: [],
            historicalParticipants: [...proposal.email.to, ...proposal.email.cc],
            subject: `Re: ${proposal.email.subject}`,
            body: `Hello,\n\nCould you please clarify the following before we update the schedule?\n\n${p.note || e.uncertainties.join('\n')}\n\nNo changes have been made to the approved schedule.\n\nThank you,\n${user.name}`,
          },
        });
      await audit(tx, user, `Proposal ${status.toLowerCase()}`, 'Proposal', p.id, proposal, {
        extraction: e,
        note: p.note,
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
        if (d.meetingId) {
          const m = await tx.meeting.findUniqueOrThrow({ where: { id: d.meetingId } });
          if (m.status !== 'Confirmed') throw new Error('Meeting is no longer confirmed.');
          const i = await tx.issuer.findUniqueOrThrow({ where: { id: m.issuerId } }),
            v = await tx.investor.findUniqueOrThrow({ where: { id: m.investorId } }),
            bankers = await tx.user.findMany({ where: { role: 'BANKER' } });
          const allowed = [i.contactEmail, v.contactEmail, ...bankers.map((b) => b.email)];
          if ([...p.to, ...p.cc].some((x) => !allowed.includes(x)))
            throw new Error(
              'Meeting attachment recipients must be the meeting contacts or internal bankers.',
            );
          await tx.meeting.update({
            where: { id: m.id },
            data: { approvedRecipients: [...p.to, ...p.cc] },
          });
        }
        await new SimulatedOutlook().deliver();
      }
      const updated = await tx.draft.update({
        where: { id: d.id },
        data: {
          to: p.to,
          cc: p.cc,
          subject: p.subject,
          body: p.body,
          ...(p.send
            ? { status: 'Simulated sent', approvedBy: user.id, simulatedSentAt: new Date() }
            : {}),
        },
      });
      await audit(
        tx,
        user,
        p.send ? 'Delivery approved and simulated' : 'Draft saved',
        'Draft',
        d.id,
        d,
        updated,
      );
      return updated;
    });
  }
  throw new Error('Unknown command.');
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
      ? db.email.findMany({ include: { proposal: true }, orderBy: { receivedAt: 'desc' } })
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
  return {
    user,
    conferences,
    issuers: issuers.map((i) =>
      user.role === 'BANKER'
        ? i
        : { id: i.id, name: i.name, sector: i.sector, color: i.color, ownerId: i.ownerId },
    ),
    investors: investors.map((i) => ({ id: i.id, name: i.name })),
    users: users.map((u) => ({ id: u.id, name: u.name, role: u.role })),
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
    parser: process.env.LLM_API_KEY ? 'Configured LLM' : 'Deterministic mock',
    demo: process.env.DEMO_MODE === 'true',
  };
}
