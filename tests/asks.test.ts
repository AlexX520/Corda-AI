/** v4 Phase 1: multi-ask parsing, safe defaults, sender checks and client-safe drafts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mockExtractAsks, type Extraction } from '../src/lib/extraction';
import { detectEscalation, resolveConference, securityFlags, senderTrust } from '../src/lib/email-trust';
import { analyse } from '../src/lib/analysis';
import {
  findCandidates,
  isOpenMeeting,
  rollupEmailStatus,
  duplicatesFor,
  requestOwner,
} from '../src/lib/review-rules';
import {
  clarificationBody,
  clientQuestions,
  findSensitive,
  outsideAllowlist,
  stripSensitiveQuotes,
} from '../src/lib/outbound';

const emails: {
  key: string;
  sender: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
}[] = JSON.parse(readFileSync(new URL('./fixtures/v4-emails.json', import.meta.url), 'utf8'));
const email = (key: string) => emails.find((e) => e.key === key)!;
const ctx = {
  conferences: [
    {
      id: 'abs-east',
      name: 'ABS East 2026',
      startDate: '2026-10-19',
      endDate: '2026-10-21',
      timezone: 'America/New_York',
    },
    {
      id: 'sf-vegas',
      name: 'Structured Finance Summit',
      startDate: '2026-11-02',
      endDate: '2026-11-04',
      timezone: 'America/Los_Angeles',
    },
  ],
  issuers: [
    ['bayview', 'Bayview', 'ir@bayview.example'],
    ['ford', 'Ford Credit', 'treasury@fordcredit.example'],
    ['santander', 'Santander', 'ir@santander.example'],
    ['athene', 'Athene', 'ir@athene.example'],
    ['onemain', 'OneMain Financial', 'ir@onemain.example'],
    ['penny', 'PennyMac', 'ir@pennymac.example'],
    ['rocket', 'Rocket Mortgage', 'ir@rocket.example'],
    ['discover', 'Discover', 'ir@discover.example'],
  ].map(([id, name, contactEmail]) => ({ id, name, contactEmail })),
  investors: [
    ['pimco', 'PIMCO'],
    ['blackrock', 'BlackRock'],
    ['wellington', 'Wellington Management'],
    ['ford-investor', 'Ford Credit'],
    ['metlife', 'MetLife'],
    ['vanguard', 'Vanguard'],
    ['kkr', 'KKR'],
    ['nuveen', 'Nuveen'],
  ].map(([id, name]) => ({ id, name, contactEmail: `meetings@${id}.example` })),
};
const internal = ['conferenceos.demo'];
const names = {
  issuer: (id: string | null) => ctx.issuers.find((i) => i.id === id)?.name || 'Unassociated',
  investor: (id: string | null) => ctx.investors.find((i) => i.id === id)?.name || '—',
};
/** The same analysis the service runs on ingest (pure core with in-memory data). */
async function read(key: string) {
  const e = email(key);
  return readEmail(e);
}
async function readEmail(e: { sender: string; to: string[]; cc: string[]; subject: string; body: string }) {
  const r = await analyse(
    { ...e, receivedAt: '2026-10-19T12:00:00Z' },
    {
      conferences: ctx.conferences,
      issuers: ctx.issuers,
      investors: ctx.investors,
      users: [
        { id: 'banker-sarah', email: 'sarah.chen@conferenceos.demo', role: 'BANKER' },
        { id: 'banker-michael', email: 'michael.torres@conferenceos.demo', role: 'BANKER' },
        { id: 'sales-james', email: 'james.wilson@conferenceos.demo', role: 'SALES' },
      ],
      meetings,
      internal,
      today: '2026-10-19',
      involvement: () => ['abs-east'],
      extract: (body: string, subject: string, c: Parameters<typeof mockExtractAsks>[2], hints: Parameters<typeof mockExtractAsks>[3]) => ({ ...mockExtractAsks(body, subject, c, hints), parser: 'rules' as const }),
    },
  );
  return { ...r, asks: r.asks };
}
const at = (iso: string | null | undefined) =>
  iso ? new Date(iso).toISOString().slice(0, 16) : null;
const meetings = [
  {
    id: 'm-ford-blackrock',
    conferenceId: 'abs-east',
    issuerId: 'ford',
    investorId: 'blackrock',
    start: '2026-10-19T14:00:00.000Z',
    end: '2026-10-19T14:30:00.000Z',
    status: 'Confirmed',
  },
  {
    id: 'm-ford-pimco',
    conferenceId: 'abs-east',
    issuerId: 'ford',
    investorId: 'pimco',
    start: '2026-10-20T17:00:00.000Z',
    end: '2026-10-20T17:30:00.000Z',
    status: 'Confirmed',
  },
  {
    id: 'm-rocket-pimco',
    conferenceId: 'abs-east',
    issuerId: 'rocket',
    investorId: 'pimco',
    start: '2026-10-20T14:00:00.000Z',
    end: '2026-10-20T14:30:00.000Z',
    status: 'Confirmed',
  },
  {
    id: 'm-bayview-pimco',
    conferenceId: 'abs-east',
    issuerId: 'bayview',
    investorId: 'pimco',
    start: '2026-10-19T19:00:00.000Z',
    end: '2026-10-19T19:30:00.000Z',
    status: 'Confirmed',
  },
  {
    id: 'm-onemain-vanguard',
    conferenceId: 'abs-east',
    issuerId: 'onemain',
    investorId: 'vanguard',
    start: '2026-10-21T13:30:00.000Z',
    end: '2026-10-21T14:00:00.000Z',
    status: 'Confirmed',
  },
];
const pickMeeting = (a: Extraction, trusted = true) =>
  findCandidates(a, meetings, { zone: 'America/New_York', trusted, open: isOpenMeeting, n: names });

test('reply-all with three numbered asks becomes three asks', async () => {
  const { asks } = await read('ford-replyall-3-asks');
  assert.deepEqual(
    asks.map((a) => a.category),
    ['Reschedule Request', 'Meeting Cancellation', 'New Meeting Request'],
  );
  assert.deepEqual(
    asks.map((a) => a.investorId),
    ['blackrock', 'pimco', 'wellington'],
  );
  assert(
    asks.every((a) => a.issuerId === 'ford'),
    'issuer comes from the sender domain',
  );
  const [move, cancel, add] = asks;
  assert.equal(at(move.referenceTime), '2026-10-19T14:00');
  assert.equal(at(move.windows[0].start), '2026-10-20T18:00'); // Tue 2:00 PM ET
  assert.equal(at(cancel.referenceTime), '2026-10-20T17:00');
  assert.equal(cancel.windows.length, 0);
  assert.equal(at(add.windows[0].start), '2026-10-20T19:30');
  assert.equal(at(add.windows[0].end), '2026-10-20T20:00');
  // Quoted history ("Please cancel nothing else") is ignored.
  assert(
    asks.every((a) => a.evidence.every((q) => email('ford-replyall-3-asks').body.includes(q))),
  );
  assert.equal(pickMeeting(move).preselectId, 'm-ford-blackrock');
  assert.equal(pickMeeting(cancel).preselectId, 'm-ford-pimco');
});

test('move … to … is a reschedule even when "cancel" appears elsewhere', async () => {
  const { asks } = mockExtractAsks(
    'Please cancel the PIMCO meeting on Tuesday at 1pm. Separately, can we move BlackRock from Monday 10am to Tuesday 2pm?',
    'ABS East 2026',
    ctx,
    { issuerId: 'ford' },
  );
  assert.deepEqual(
    asks.map((a) => a.operation),
    ['cancel', 'reschedule'],
  );
  assert.equal(asks[1].investorId, 'blackrock');
  assert.equal(at(asks[1].windows[0].start), '2026-10-20T18:00');
});

test('clean reschedule names both times and pre-selects the matching meeting', async () => {
  const { asks } = await read('ford-clean-reschedule');
  assert.equal(asks.length, 1);
  assert.equal(asks[0].operation, 'reschedule');
  assert.equal(at(asks[0].referenceTime), '2026-10-19T14:00');
  assert.equal(at(asks[0].windows[0].start), '2026-10-20T18:00');
  const pick = pickMeeting(asks[0]);
  assert.equal(pick.preselectId, 'm-ford-blackrock');
  assert.match(pick.why, /Time matches/);
});

test('investor cancellation without event name: one ask per issuer, investor from sender, "still on" ignored', async () => {
  const { trust, asks } = await read('pimco-cancel-no-conference');
  assert.equal(trust.investorId, 'pimco');
  assert.deepEqual(
    asks.map((a) => [a.operation, a.issuerId, a.investorId]),
    [
      ['cancel', 'rocket', 'pimco'],
      ['cancel', 'ford', 'pimco'],
    ],
  );
  assert.equal(pickMeeting(asks[0]).preselectId, 'm-rocket-pimco');
  assert.equal(pickMeeting(asks[1]).preselectId, 'm-ford-pimco');
  assert(!asks.some((a) => a.issuerId === 'bayview'));
});

test('time zones: ET kept, the UK duplicate ignored, "nothing before 1pm" blocks the morning', async () => {
  const { asks } = await read('santander-cfo-timezones');
  assert.equal(asks.length, 2);
  const [block, move] = asks;
  assert.equal(block.category, 'Issuer Availability Update');
  assert.deepEqual(
    block.windows.map((w) => [w.kind, at(w.start), at(w.end)]),
    [['unavailable', '2026-10-19T04:00', '2026-10-19T17:00']],
  );
  assert.equal(move.operation, 'reschedule');
  assert.equal(move.investorId, 'wellington');
  assert.equal(at(move.referenceTime), '2026-10-19T15:00');
  assert.deepEqual(
    move.windows.map((w) => at(w.start)),
    ['2026-10-19T18:30'],
  ); // 2:30 PM ET, not 7:30 PM
  assert(move.vague.some((v) => v.includes('Tuesday morning')));
  assert(
    !move.uncertainties.some((u) => u.includes('Tuesday morning')),
    'an alternative does not block approval',
  );
});

test('a time stated in another zone is converted to the conference zone', async () => {
  const e = mockExtractAsks('Can we move PGIM to Tuesday 9:30am Central?', 'ABS East 2026', ctx, {
    issuerId: 'ford',
  }).asks[0];
  assert.equal(at(e.windows[0].start), '2026-10-20T14:30'); // 9:30 CT = 10:30 ET = 14:30 UTC
});

test('complaint and urgent same-day emails are flagged, with their real asks kept', async () => {
  for (const key of ['pennymac-complaint', 'discover-kkr-urgent']) {
    const r = await read(key);
    assert.equal(r.escalation, true, key);
    assert.equal(r.asks[0].category, 'Escalation / complaint');
    assert.equal(r.asks[0].operation, 'escalate');
    assert(r.asks.slice(1).every((a) => a.fromEscalation), 'other asks are marked from an escalation');
  }
  const kkr = await read('discover-kkr-urgent');
  assert.equal(kkr.asks[0].investorId, 'kkr');
  assert.equal(detectEscalation('Schedule', 'Bayview is available Monday 3-5pm.').reasons.length, 0);
  assert.equal(detectEscalation('Schedule', 'Pls let me know asap.').reasons.length, 0, '"asap" alone is not urgent');
});

test('lookalike sender is unverified, links and credential requests are flagged, nothing is pre-selected', async () => {
  const e = email('phishing-lookalike');
  const { trust, asks } = await read('phishing-lookalike');
  assert.equal(trust.status, 'unverified');
  assert.equal(trust.lookalikeOf, 'bayview.example');
  const flags = securityFlags(e.subject, e.body);
  assert(flags.some((f) => f.includes('link')));
  assert(flags.some((f) => f.includes('credentials')));
  assert.equal(asks[0].category, 'Reschedule Request', 'unverified senders are never escalated');
  assert.equal((await read('phishing-lookalike')).suspicious, true);
  assert.equal(pickMeeting(asks[0], false).preselectId, null);
  assert.equal(senderTrust('treasury@fordcredit.example', { ...ctx, internal }).status, 'verified');
  assert.equal(
    senderTrust('james.wilson@conferenceos.demo', { ...ctx, internal }).status,
    'internal',
  );
});

test('MNPI forward: cancel ask kept, deal terms flagged and kept out of client questions', async () => {
  const e = email('mnpi-forward');
  const { trust, asks } = await read('mnpi-forward');
  assert.equal(trust.status, 'internal');
  assert.deepEqual(
    asks.map((a) => [a.operation, a.issuerId, a.investorId]),
    [['cancel', 'ford', 'pimco']],
  );
  assert(findSensitive(e.body).includes('project'));
  assert(securityFlags(e.subject, e.body).some((f) => f.includes('MNPI')));
  const body = clarificationBody(
    clientQuestions(
      asks[0],
      { issuer: 'Ford Credit', investor: 'PIMCO', conference: null },
      'other',
    ),
    'Sarah Chen',
  );
  assert.equal(findSensitive(body).length, 0);
  assert(!/uncertain|parser|association/i.test(body), 'no diagnostics in client email');
  const stripped = stripSensitiveQuotes(
    `Hi\n> Ford Credit is wall-crossed on Project Mustang\nThanks`,
  );
  assert.equal(stripped.removed, 1);
  assert(!stripped.text.includes('Mustang'));
});

test('duplicate request is detected; second slot keeps attendees and alternative', async () => {
  const dupe = (await read('vanguard-duplicate')).asks[0];
  assert.equal(dupe.category, 'New Meeting Request');
  assert.deepEqual([dupe.issuerId, dupe.investorId], ['onemain', 'vanguard']);
  assert.equal(at(dupe.windows[0].start), '2026-10-21T13:30');
  assert.equal(dupe.durationMinutes, 30);
  assert.equal(duplicatesFor(dupe, meetings, []).length, 1);
  const second = (await read('blackrock-2nd-slot')).asks[0];
  assert.deepEqual(
    [second.category, second.issuerId, second.investorId, second.attendees],
    ['New Meeting Request', 'athene', 'blackrock', 6],
  );
  assert.equal(at(second.windows[0].start), '2026-10-21T13:30');
  assert(second.vague.some((v) => v.includes('after lunch')));
});

test('typo-heavy vague availability invents no windows and asks for exact times', async () => {
  const { asks } = await read('discover-typo-vague');
  assert.equal(asks.length, 1);
  assert.equal(asks[0].issuerId, 'discover');
  assert.equal(asks[0].windows.length, 0);
  assert.equal(asks[0].vague.length, 2);
  assert(asks[0].missing.includes('exactTime'));
  const q = clientQuestions(
    asks[0],
    { issuer: 'Discover', investor: null, conference: 'ABS East 2026' },
    'issuer',
  );
  assert.equal(q.length, 2);
  assert(q[0].includes('tues after lunch till ~4ish'));
});

test('pre-selection rules: investor must match, several candidates need a pick, time mismatch is explained', async () => {
  const base = {
    conferenceId: 'abs-east',
    issuerId: 'ford',
    investorId: null,
    referenceTime: null,
  } as const;
  assert.equal(
    pickMeeting(base as unknown as Extraction).preselectId,
    null,
    'two Ford meetings, no investor named',
  );
  const wrongTime = pickMeeting({
    ...base,
    investorId: 'blackrock',
    referenceTime: '2026-10-19T15:00:00.000Z',
  } as unknown as Extraction);
  assert.equal(wrongTime.preselectId, null);
  assert.match(wrongTime.why, /Email says Mon 11:00 AM; this meeting is Mon 10:00 AM/);
  const otherInvestor = pickMeeting({ ...base, investorId: 'kkr' } as unknown as Extraction);
  assert.equal(otherInvestor.candidates.length, 0);
});

test('email status is resolved only when every ask is done', async () => {
  assert.equal(rollupEmailStatus(['Approved', 'Pending', 'Pending']), 'Pending review');
  assert.equal(
    rollupEmailStatus(['Approved', 'Clarification requested']),
    'Clarification requested',
  );
  assert.equal(rollupEmailStatus(['Approved', 'Approved']), 'Approved');
  assert.equal(rollupEmailStatus(['Approved', 'Rejected', 'Acknowledged']), 'Resolved');
});

test('event resolution: only event of the company, else only active event, else ask', async () => {
  const conferences = [
    { id: 'abs-east', name: 'ABS East 2026', endDate: '2026-10-21' },
    { id: 'sf-vegas', name: 'Structured Finance Summit', endDate: '2026-11-04' },
    { id: 'ndr', name: 'NDR Boston', endDate: '2026-11-17' },
  ];
  assert.equal(
    resolveConference({
      conferences,
      involved: ['abs-east'],
      entityName: 'PIMCO',
      today: '2026-11-03',
    }).conferenceId,
    'abs-east',
  );
  assert.equal(
    resolveConference({
      conferences: conferences.slice(0, 2),
      involved: [],
      entityName: null,
      today: '2026-11-03',
    }).conferenceId,
    'sf-vegas',
  );
  const none = resolveConference({
    conferences,
    involved: [],
    entityName: null,
    today: '2026-11-03',
  });
  assert.equal(none.conferenceId, null);
  assert.match(none.note, /Which event/);
});

test('a request from an email belongs to the salesperson on it, never the approving banker', async () => {
  const users = [
    { id: 'banker-sarah', email: 'sarah.chen@conferenceos.demo', role: 'BANKER' },
    { id: 'sales-james', email: 'james.wilson@conferenceos.demo', role: 'SALES' },
    { id: 'sales-emma', email: 'emma.davis@conferenceos.demo', role: 'SALES' },
  ];
  const ford = email('ford-replyall-3-asks');
  assert.equal(requestOwner(ford, users, 'banker-sarah'), 'sales-james');
  assert.equal(requestOwner(email('blackrock-2nd-slot'), users, 'banker-sarah'), 'sales-emma');
  assert.equal(
    requestOwner(email('vanguard-duplicate'), users, 'banker-alex'),
    'banker-alex',
    'falls back to the coverage banker',
  );
});

test('recipient allowlist flags unknown domains', async () => {
  assert.deepEqual(
    outsideAllowlist(
      ['ir@bayview.example', 'x@gmail.example', 'a@conferenceos.demo'],
      ['bayview.example', 'conferenceos.demo'],
    ),
    ['x@gmail.example'],
  );
});
