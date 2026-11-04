/** v4 fix round 2: regression tests built from the emails the simulated users injected. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readEmail, type TestEmail } from './fixtures/context';
import { mockExtractAsks } from '../src/lib/extraction';
import { splitForward } from '../src/lib/rule-parser';
import { ctx } from './fixtures/context';

const all: (TestEmail & { messageId: string })[] = JSON.parse(
  readFileSync(new URL('./fixtures/round2-emails.json', import.meta.url), 'utf8'),
);
const mail = (id: string) => all.find((e) => e.messageId === id)!;
const read = (id: string) => readEmail(mail(id));
const local = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }) : null;
const parse = (text: string, hints = {}) =>
  mockExtractAsks(text, 'ABS East 2026', ctx, { senderIssuerId: 'ford', ...hints }).asks;

test('A: a forward is read from the forwarded message, attributed to its author, forwarder kept', async () => {
  const r = await read('r2-A1');
  assert.equal(r.originalSender, 'treilly@blackrock.example');
  assert.equal(r.forwardedBy, 'james.wilson@conferenceos.demo');
  assert.equal(r.asks.length, 1);
  const [a] = r.asks;
  assert.deepEqual([a.category, a.issuerId, a.investorId, a.attendees], ['New Meeting Request', 'bayview', 'blackrock', 3]);
  assert.equal(local(a.windows[0].start), 'Tue 2:00 PM');
  assert.equal(local(a.windows[0].end), 'Tue 2:45 PM');
  assert.equal(r.escalation, false, '"let me know asap" is not an escalation');
  const md = await read('md2-003-pimco-2nd-slot');
  assert.deepEqual(md.asks.map((x) => [x.issuerId, x.investorId]), [['gmf', 'pimco'], ['ford', 'pimco']]);
  assert.equal(md.asks[0].flexible, true, '"any time 10-12" is a window to fit a meeting in');
  const f = splitForward(mail('coordinator-e2-dupe-athene').body);
  assert.equal(f.forwarded?.fromEmail, 'thale@blackrock.example');
  assert.equal(f.forwarded?.fromName, 'Tom Hale');
});

test('A: a lookalike inside a forward from a colleague is still flagged', async () => {
  const r = await read('r2-B10');
  assert.equal(r.trust.status, 'unverified');
  assert(r.flags.some((f) => f.startsWith('Forwarded message is from an unverified sender')));
  assert(r.flags.some((f) => f.includes('data theft')));
  assert.equal(r.suspicious, true);
  assert.equal(r.asks[0].operation, 'cancel');
});

test('C: escalations are flags; embedded asks survive; investor threats protect the meeting', async () => {
  const gmf = await read('coordinator-e4-gmf-sameday');
  assert.equal(gmf.escalation, true);
  assert.deepEqual(gmf.asks.map((a) => a.category), ['Escalation / complaint', 'Reschedule Request', 'Issuer Availability Update']);
  assert(gmf.asks.slice(1).every((a) => a.fromEscalation));
  assert.equal(local(gmf.asks[1].windows[0].start), 'Mon 10:30 AM');
  assert.equal(local(gmf.asks[2].windows[0].start), 'Tue 10:00 AM', '9-10am Central is 10-11 ET');
  const br = await read('md2-006-blackrock-escalation');
  assert.equal(br.threat, true);
  assert.equal(br.protectMeetingId, 'seed-meeting-1');
  assert.deepEqual(br.asks.map((a) => a.category), ['Escalation / complaint'], 'narrated "may be moving" is not an ask');
  const complaint = await read('md2-002-gmf-complaint');
  assert.equal(complaint.asks.length, 1);
});

test('D: reschedule "from … to …", conditional asks and preferred times', async () => {
  const ford = await read('coordinator-e1-ford-fw');
  assert.deepEqual(
    ford.asks.map((a) => a.category),
    ['Reschedule Request', 'New Meeting Request', 'Meeting Cancellation', 'New Meeting Request'],
    'no ghost ask from the intro line',
  );
  assert.equal(local(ford.asks[0].referenceTime), 'Tue 1:00 PM');
  assert.equal(local(ford.asks[0].windows[0].start), 'Tue 3:30 PM');
  assert.equal(ford.asks[3].investorId, 'nuveen', '"offer the freed 1pm to Nuveen" is a new request');
  assert.equal(local(ford.asks[3].windows[0].start), 'Tue 1:00 PM');
  const gmf = await read('md2-001-gmf-cfo-tz');
  const pgim = gmf.asks.find((a) => a.investorId === 'pgim')!;
  assert.equal(local(pgim.windows[0].start), 'Tue 9:30 AM', '"9:30 ET (8:30 our time)" is explicit');
  assert.equal(pgim.missing.includes('exactTime'), false);
  const fid = gmf.asks.find((a) => a.investorId === 'fidelity')!;
  assert.equal(fid.conditional, true, '"prefer 3:30 … if not, keep 3" is conditional');
  assert.equal(local(fid.windows[0].start), 'Mon 3:30 PM');
  const vanguard = await read('coordinator-e5-vanguard-room');
  const update = vanguard.asks.find((a) => a.category === 'Meeting Update')!;
  assert.equal(update.attendees, 11);
  const move = vanguard.asks.find((a) => a.category === 'Reschedule Request')!;
  assert.equal(move.conditional, true, '"or we\'d rather move it" is conditional');
  const wellington = await read('coordinator-e3b-wellington-move');
  assert.deepEqual(wellington.asks.map((a) => [a.category, a.issuerId, a.investorId]), [
    ['Reschedule Request', 'bayview', 'wellington'],
  ]);
  assert.equal(local(wellington.asks[0].windows[0].start), 'Wed 11:00 AM');
});

test('D: ranges, durations, attendee counts and request phrasing', () => {
  const [a] = parse('Bayview is available Tuesday between 2 and 4pm.', { senderIssuerId: 'bayview' });
  assert.equal(local(a.windows[0].start), 'Tue 2:00 PM');
  assert.equal(local(a.windows[0].end), 'Tue 4:00 PM');
  const [b] = parse('Bayview is available Tuesday 1:00–3:30 pm.', { senderIssuerId: 'bayview' });
  assert.equal(local(b.windows[0].end), 'Tue 3:30 PM');
  const [c] = parse('Can we get Athene x BlackRock Tue 11am for an hour? Party of 6.', { senderIssuerId: null });
  assert.deepEqual([c.category, c.issuerId, c.investorId, c.attendees, c.durationMinutes], ['New Meeting Request', 'athene', 'blackrock', 6, 60]);
  const [d] = parse('Could we add PIMCO on Wednesday at 10am, 45 min?');
  assert.equal(local(d.windows[0].end), 'Wed 10:45 AM');
  const e = mockExtractAsks('Hi Sarah,\nHope the week is going well.\n\nThanks,\nMark', 'Hello', ctx, { senderIssuerId: 'ford' }).asks;
  assert.equal(e.length, 1);
  assert.notEqual(e[0].category, 'Reschedule Request');
  const [f] = parse('If 2:30 doesn\'t work, move the PIMCO meeting to Wednesday at 11am.');
  assert.equal(f.conditional, true);
});

test('E2: Discover reply-all: cancel, move, and "could we fit them" request', async () => {
  const r = await read('md2-005-discover-replyall');
  assert.deepEqual(r.asks.map((a) => [a.operation, a.investorId]), [
    ['cancel', 'kkr'],
    ['reschedule', 'wellington'],
    ['inquiry', 'apollo'],
  ]);
  assert.equal(r.asks[2].category, 'New Meeting Request');
});

test('I: security flags for lookalikes, disguised links, hidden instructions and deal terms', async () => {
  for (const id of ['r2-B1', 'r2-B2', 'r2-B3', 'r2-B4', 'r2-B5', 'coordinator-e6-lookalike', 'md2-004-gmf-lookalike']) {
    const r = await read(id);
    assert.equal(r.trust.status, 'unverified', id);
    assert(r.trust.lookalikeOf, `${id} is a lookalike`);
    assert.equal(r.suspicious, true);
  }
  assert((await read('r2-B6')).suspicious, 'credential portal from a registered address is suspicious');
  assert((await read('r2-B7')).flags.some((f) => f.includes('disguised or bare link')));
  for (const id of ['r2-B8', 'r2-B9']) assert((await read(id)).flags.some((f) => f.includes('hidden or embedded')), id);
  assert((await read('r2-B8')).flags.some((f) => f.includes('data theft')), 'cc to a gmail address');
  assert((await read('r2-B11')).flags.some((f) => /over the wall|under nda/.test(f)));
  assert((await read('r2-B12')).flags.some((f) => /merger|not yet announced/.test(f)));
  assert.equal((await read('coordinator-e6-lookalike')).flags.some((f) => f.includes('data theft')), true);
});

test('A2: PIMCO second slot reads the new time, not the slot they could not make', async () => {
  const r = await read('r2-A2');
  const add = r.asks.find((a) => a.category === 'New Meeting Request')!;
  assert.equal(local(add.windows[0].start), 'Wed 11:00 AM');
  assert.equal(local(add.windows[0].end), 'Wed 11:45 AM');
});

test('round 3: unhandled sentences surface questions no ask covers', async () => {
  const { unhandledSentences } = await import('../src/lib/review-rules');
  const body = 'Hi Sarah,\n\n1) BlackRock asked for time with us — Jen can do Wed 11:00-11:30am ET. Please lock that in.\n\nCan you also confirm the room has a screen for the deck?\n\nThanks,\nMark';
  const out = unhandledSentences(body, ['BlackRock asked for time with us — Jen can do Wed 11:00-11:30am ET. Please lock that in.']);
  assert.deepEqual(out.map((x) => [x.text, x.question]), [['Can you also confirm the room has a screen for the deck?', true]]);
});
