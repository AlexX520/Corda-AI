import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { db } from '../src/lib/db';
import { command, getState } from '../src/lib/service';
import { extractionSchema } from '../src/lib/extraction';
const enabled = process.env.RUN_INTEGRATION === 'true';
test(
  'persistent workflow, approval boundaries, RBAC, concurrent booking, exports and simulated delivery',
  { skip: !enabled, timeout: 60000 },
  async () => {
    const prefix = `integration-${Date.now()}`,
      conferenceId = prefix;
    const banker = await db.user.findUniqueOrThrow({ where: { id: 'banker-alex' } }),
      sales = await db.user.findUniqueOrThrow({ where: { id: 'sales-james' } }),
      other = await db.user.findUniqueOrThrow({ where: { id: 'sales-emma' } });
    const c = await db.conference.create({
      data: {
        id: conferenceId,
        name: prefix,
        location: 'Test',
        timezone: 'America/New_York',
        startDate: '2026-10-19',
        endDate: '2026-10-21',
      },
    });
    const ids: string[] = [conferenceId, 'bayview'];
    try {
      const mail = (await command(banker, 'ingest', {
        messageId: `${prefix}-email`,
        threadId: prefix,
        sender: 'ir@bayview.example',
        to: [banker.email],
        subject: `${prefix} Bayview availability`,
        body: `Bayview is available Monday between 3 PM and 5 PM for ${prefix}.`,
        conferenceId,
        issuerId: 'bayview',
      })) as { id: string };
      ids.push(mail.id);
      await assert.rejects(
        () =>
          command(banker, 'ingest', {
            messageId: `${prefix}-email`,
            threadId: prefix,
            sender: 'ir@bayview.example',
            to: [banker.email],
            subject: 'Duplicate',
            body: 'Duplicate',
          }),
        /already been ingested/,
      );
      assert.equal(
        await db.availability.count({ where: { conferenceId } }),
        0,
        'proposals must not mutate approved availability',
      );
      const proposal = await db.proposal.findUniqueOrThrow({ where: { emailId: mail.id } });
      ids.push(proposal.id);
      const extraction = extractionSchema.parse(proposal.extraction);
      assert.equal(extraction.windows.length, 1);
      await assert.rejects(
        () => command(sales, 'review', { id: proposal.id, decision: 'approve' }),
        /Forbidden/,
      );
      await command(banker, 'review', { id: proposal.id, decision: 'approve' });
      assert.equal(await db.availability.count({ where: { conferenceId } }), 1);
      await assert.rejects(
        () => command(banker, 'review', { id: proposal.id, decision: 'approve' }),
        /already been reviewed/,
      );
      const request = {
        conferenceId,
        issuerId: 'bayview',
        investorId: 'pimco',
        start: '2026-10-19T19:00:00.000Z',
        end: '2026-10-19T19:30:00.000Z',
        duration: 30,
        notes: prefix,
      };
      const r1 = (await command(sales, 'request', request)) as { id: string; status: string };
      ids.push(r1.id);
      assert.equal(r1.status, 'Potential Match');
      await assert.rejects(
        () => command(other, 'alternative', { id: r1.id, start: request.start }),
        /Forbidden/,
      );
      const r2 = (await command(other, 'request', { ...request, investorId: 'blackrock' })) as {
        id: string;
      };
      ids.push(r2.id);
      const attempts = await Promise.allSettled([
        command(banker, 'confirm', { id: r1.id, location: 'Room 1', consent: true }),
        command(banker, 'confirm', { id: r2.id, location: 'Room 1', consent: true }),
      ]);
      assert.equal(
        attempts.filter((a) => a.status === 'fulfilled').length,
        1,
        'concurrent approvals must not double book',
      );
      assert.equal(await db.meeting.count({ where: { conferenceId } }), 1);
      const m = await db.meeting.findFirstOrThrow({ where: { conferenceId } });
      ids.push(m.id);
      const draft = await db.draft.findFirstOrThrow({ where: { meetingId: m.id } });
      ids.push(draft.id);
      assert.deepEqual(draft.to, [], 'historical participants are not auto-added');
      await assert.rejects(
        () =>
          command(banker, 'draft', {
            id: draft.id,
            to: ['unauthorized@example.com'],
            cc: [],
            subject: draft.subject,
            body: draft.body,
            send: true,
            recipientsApproved: true,
          }),
        /recipients must/,
      );
      await command(banker, 'draft', {
        id: draft.id,
        to: ['ir@bayview.example'],
        cc: [],
        subject: draft.subject,
        body: draft.body,
        send: true,
        recipientsApproved: true,
      });
      assert.equal(
        (await db.draft.findUniqueOrThrow({ where: { id: draft.id } })).status,
        'Simulated sent',
      );
      const salesState = await getState(sales);
      assert.equal(salesState.emails.length, 0);
      assert(salesState.requests.every((r) => r.salespersonId === sales.id));
      assert.equal(salesState.auditLogs.length, 0);
      const losing = m.requestId === r1.id ? r2 : r1;
      const losingUser = losing.id === r1.id ? sales : other;
      const state = await getState(losingUser);
      const pending = state.requests.find((r) => r.id === losing.id)!;
      assert(pending.alternatives.length > 0);
      await command(losingUser, 'alternative', {
        id: losing.id,
        start: new Date(pending.alternatives[0].start).toISOString(),
      });
      assert.equal(
        (await db.meetingRequest.findUniqueOrThrow({ where: { id: losing.id } })).status,
        'Awaiting Banker Approval',
      );
      await command(banker, 'availability', {
        conferenceId,
        issuerId: 'bayview',
        start: '2026-10-19T20:00:00.000Z',
        end: '2026-10-19T21:00:00.000Z',
        operation: 'replace',
        kind: 'Available',
        replaceConfirmed: true,
      });
      assert.equal(
        (await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).status,
        'Confirmed',
      );
      assert(
        (await db.action.count({ where: { conferenceId, type: 'Availability conflict' } })) > 0,
      );
      const ambiguous = (await command(banker, 'ingest', {
        messageId: `prefix-${prefix}-ambiguous`,
        threadId: prefix,
        sender: 'ir@bayview.example',
        to: [banker.email],
        subject: `${prefix} Bayview availability`,
        body: `Bayview is available Tuesday morning for ${prefix}.`,
        conferenceId,
        issuerId: 'bayview',
      })) as { id: string };
      ids.push(ambiguous.id);
      const p2 = await db.proposal.findUniqueOrThrow({ where: { emailId: ambiguous.id } });
      ids.push(p2.id);
      await assert.rejects(
        () => command(banker, 'review', { id: p2.id, decision: 'approve' }),
        /uncertainty/,
      );
      await command(banker, 'review', {
        id: p2.id,
        decision: 'clarify',
        note: 'Please specify exact Tuesday start and end times.',
      });
      assert((await db.draft.count({ where: { emailId: ambiguous.id } })) > 0);
      const url = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
      assert.equal((await fetch(`${url}/api/state`)).status, 401);
      const login = await fetch(`${url}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: url },
        body: JSON.stringify({ userId: banker.id }),
      });
      const cookie = login.headers.get('set-cookie')!.split(';')[0];
      const xlsx = await fetch(
        `${url}/api/export?conferenceId=${conferenceId}&scope=issuer&id=bayview&recipient=ir%40bayview.example`,
        { headers: { cookie } },
      );
      assert.equal(xlsx.status, 200);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(Buffer.from(await xlsx.arrayBuffer()) as never);
      assert.equal(workbook.worksheets[0].rowCount, 2);
      const noAccess = await fetch(
        `${url}/api/export?conferenceId=${conferenceId}&scope=issuer&id=bayview&recipient=other%40example.com`,
        { headers: { cookie } },
      );
      const emptyBook = new ExcelJS.Workbook();
      await emptyBook.xlsx.load(Buffer.from(await noAccess.arrayBuffer()) as never);
      assert.equal(emptyBook.worksheets[0].rowCount, 1);
      const ics = await fetch(
        `${url}/api/export?conferenceId=${conferenceId}&scope=meeting&id=${m.id}&format=ics`,
        { headers: { cookie } },
      );
      assert.match(await ics.text(), /BEGIN:VEVENT/);
      const salesLogin = await fetch(`${url}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: other.id }),
      });
      const salesCookie = salesLogin.headers.get('set-cookie')!.split(';')[0];
      const denied = await fetch(`${url}/api/commands`, {
        method: 'POST',
        headers: { cookie: salesCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'availability', data: {} }),
      });
      assert.equal(denied.status, 403);
      console.log(
        'Integration verified: proposals, dedupe, reviews, concurrency, RBAC, alternatives, preservation, clarification, recipient scopes, XLSX and ICS.',
      );
    } finally {
      const mails = await db.email.findMany({ where: { conferenceId } }),
        meetings = await db.meeting.findMany({ where: { conferenceId } }),
        requests = await db.meetingRequest.findMany({ where: { conferenceId } });
      const emailIds = mails.map((e) => e.id),
        meetingIds = meetings.map((m) => m.id),
        requestIds = requests.map((r) => r.id);
      const drafts = await db.draft.findMany({
        where: {
          OR: [
            { meetingId: { in: meetingIds } },
            { emailId: { in: emailIds } },
            { requestId: { in: requestIds } },
          ],
        },
      });
      const actions = await db.action.findMany({ where: { conferenceId } });
      ids.push(...drafts.map((d) => d.id), ...actions.map((a) => a.id));
      await db.draft.deleteMany({ where: { id: { in: drafts.map((d) => d.id) } } });
      await db.action.deleteMany({ where: { conferenceId } });
      await db.meeting.deleteMany({ where: { conferenceId } });
      await db.meetingRequest.deleteMany({ where: { conferenceId } });
      await db.availability.deleteMany({ where: { conferenceId } });
      await db.proposal.deleteMany({ where: { emailId: { in: emailIds } } });
      await db.email.deleteMany({ where: { conferenceId } });
      await db.auditLog.deleteMany({
        where: {
          OR: [
            { entityId: { in: ids.filter((x) => x !== 'bayview') } },
            { entityId: 'bayview', after: { path: ['conferenceId'], equals: conferenceId } },
          ],
        },
      });
      await db.conference.delete({ where: { id: conferenceId } });
      await db.$disconnect();
    }
  },
);
