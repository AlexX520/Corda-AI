import test from 'node:test';
import assert from 'node:assert/strict';
import { mockExtractAsks } from '../src/lib/rule-parser';
import { availabilityMode, findCandidates, unhandledSentences } from '../src/lib/review-rules';
import { detectEscalation, resolveConference } from '../src/lib/email-trust';
import emails from './fixtures/round3-emails.json';

const zone = 'America/New_York';
const body = (id: string) => (emails as { messageId: string; body: string }[]).find((e) => e.messageId.includes(id))!.body;
const ctx = {
  conferences: [
    { id: 'abs-east', name: 'ABS East 2026', startDate: '2026-11-02', endDate: '2026-11-04', timezone: zone },
    { id: 'discover-ndr', name: 'Discover NDR — Boston', startDate: '2026-11-10', endDate: '2026-11-10', timezone: zone },
  ],
  issuers: [{ id: 'discover', name: 'Discover' }, { id: 'ford', name: 'Ford Credit' }, { id: 'athene', name: 'Athene' }],
  investors: [{ id: 'pimco', name: 'PIMCO' }, { id: 'wellington', name: 'Wellington Management' }, { id: 'blackrock', name: 'BlackRock' }],
};
const n = { issuer: (id: string | null) => ctx.issuers.find((i) => i.id === id)?.name || '', investor: (id: string | null) => ctx.investors.find((i) => i.id === id)?.name || '', conference: (id: string | null) => id || '' };

test('round 3 fixtures: 21 injected emails are kept as regression data', () => {
  assert.equal((emails as unknown[]).length, 21);
});

test('"do not move it again … we will skip it" is a threat, not a move ask', () => {
  const text = body('e05-blackrock-hold');
  assert.equal(detectEscalation('Ford follow-up - please do not move again', text).threat, true);
  const asks = mockExtractAsks(text, 'x', ctx as never, { investorId: 'blackrock', defaultConferenceId: 'abs-east', receivedAt: '2026-11-03T19:00:00Z' } as never).asks;
  assert(!asks.some((a) => a.operation === 'reschedule'));
});

test('events are resolved from "Boston NDR" and "today\'s meeting"', () => {
  const conferences = ctx.conferences.map((c) => ({ ...c }));
  assert.equal(resolveConference({ conferences, involved: ['abs-east', 'discover-ndr'], entityName: 'Discover', today: '2026-11-03', text: body('e14-discover-ndr') }).conferenceId, 'discover-ndr');
  assert.equal(resolveConference({ conferences, involved: ['abs-east', 'discover-ndr'], entityName: 'Discover', today: '2026-11-03', text: body('e15-past') }).conferenceId, 'abs-east');
});

test('availability: "can now ALSO do" extends, a plain statement narrows the day', () => {
  assert.equal(availabilityMode('Our CFO can now ALSO do 9:00-11:00am Wed'), 'extend');
  assert.equal(availabilityMode('CFO free 9–11 and 2–4 Wed'), 'narrow');
});

test('wrong-meeting guards: a past meeting or a different weekday is never pre-selected', () => {
  const meetings = [
    { id: 'tue-ford-pimco', conferenceId: 'abs-east', issuerId: 'ford', investorId: 'pimco', start: '2026-11-03T18:00:00Z', end: '2026-11-03T18:30:00Z', status: 'Confirmed' },
  ];
  const ask = { conferenceId: 'abs-east', issuerId: 'ford', investorId: 'pimco', referenceTime: null, evidence: ['Please drop the PIMCO lunch on Thursday, we\'re flying back.'] };
  const before = findCandidates(ask, meetings, { zone, trusted: true, open: () => true, n, now: new Date('2026-11-03T12:00:00Z') });
  assert.equal(before.preselectId, null, 'Thursday does not match a Tuesday meeting');
  const past = findCandidates({ ...ask, evidence: ['cancel PIMCO'] }, meetings, { zone, trusted: true, open: () => true, n, now: new Date('2026-11-03T20:00:00Z') });
  assert.equal(past.candidates.length, 0, 'a meeting that already took place is not a candidate');
});

test('the screen question in the Athene email is surfaced as unhandled', () => {
  const out = unhandledSentences(body('boss-e1-athene'), ['BlackRock asked for time with us — Jen (CFO) can do Wed 11:00-11:30am ET. Please lock that in.']);
  assert(out.some((x) => x.question && /screen/.test(x.text)));
});

test('hero email: a time offered for a named investor is a meeting request; a header day carries to bullets', () => {
  const c = { ...ctx, issuers: [...ctx.issuers, { id: 'bayview', name: 'Bayview' }], investors: [...ctx.investors, { id: 'ares', name: 'Ares Management' }] };
  const hint = { defaultConferenceId: 'abs-east', receivedAt: '2026-11-03T19:00:00Z' };
  const hero = mockExtractAsks('BlackRock asked for time with us. Jen (our CFO) can do tomorrow 11:00-11:30am ET with BlackRock. Please lock that in.', 'RE: x', c as never, { ...hint, issuerId: 'athene' } as never).asks;
  assert.equal(hero[0].category, 'New Meeting Request');
  assert.equal(hero[0].investorId, 'blackrock');
  const moves = mockExtractAsks('All - three things for tomorrow:\n\n- Ares 10:30 needs to move to 11:30am (our CEO has a rating agency call)', 'RE: x', c as never, { ...hint, issuerId: 'bayview' } as never).asks;
  assert.equal(moves[0].windows[0].start, '2026-11-04T16:30:00.000Z');
  assert.equal(moves[0].referenceTime, '2026-11-04T15:30:00.000Z');
});
