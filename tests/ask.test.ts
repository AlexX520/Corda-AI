import test from 'node:test';
import assert from 'node:assert/strict';
import { answerQuestion, dayIn, type AskSnapshot } from '../src/lib/ask';

const zone = 'America/New_York';
const at = (d: string, t: string) => new Date(`${d}T${t}:00-05:00`);
const base: AskSnapshot = {
  now: at('2026-11-03', '08:00'),
  user: { id: 'banker-alex', role: 'BANKER', name: 'Alex Morgan' },
  conferences: [{ id: 'abs', name: 'ABS East 2026', startDate: '2026-11-02', endDate: '2026-11-04', timezone: zone, slotMinutes: 30 }],
  issuers: [
    { id: 'ford', name: 'Ford Credit', ownerId: 'banker-alex' },
    { id: 'ally', name: 'Ally Financial', ownerId: 'banker-maya' },
  ],
  investors: [
    { id: 'pimco', name: 'PIMCO', coverageSalesId: 'sales-james' },
    { id: 'vanguard', name: 'Vanguard', coverageSalesId: 'sales-emma' },
  ],
  users: [{ id: 'banker-alex', name: 'Alex Morgan' }, { id: 'banker-maya', name: 'Maya Patel' }],
  meetings: [
    { id: 'm1', conferenceId: 'abs', issuerId: 'ford', investorId: 'pimco', start: at('2026-11-03', '13:00'), end: at('2026-11-03', '13:30'), status: 'Confirmed', location: '', bankerIds: ['banker-alex'], requiresCube: true, expectedAttendees: 4 },
    { id: 'm2', conferenceId: 'abs', issuerId: 'ally', investorId: 'vanguard', start: at('2026-11-03', '10:00'), end: at('2026-11-03', '10:30'), status: 'Confirmed', location: 'Tresor · 103', bankerIds: [], requiresCube: true, expectedAttendees: 9 },
  ],
  coverage: [],
  rooms: [],
  cubes: [],
  emails: [{ id: 'e1', subject: 'Ford Credit — PIMCO room', issuerId: 'ford', investorId: 'pimco', status: 'Pending review', receivedAt: at('2026-11-03', '07:00') }],
  availability: [{ issuerId: 'ford', conferenceId: 'abs', start: at('2026-11-03', '09:00'), end: at('2026-11-03', '12:00'), kind: 'Available' }],
};
const historySince = async () => [{ id: 'h2', createdAt: at('2026-11-03', '07:30').toISOString(), action: 'Meeting edited (room)', actor: 'Sarah Chen', note: null, meetingId: 'm1', subject: 'Ford Credit × PIMCO' }];
const history = async () => [
  { id: 'h1', createdAt: at('2026-11-02', '15:04').toISOString(), action: 'Meeting moved from email', actor: 'Maya Patel', note: 'Client asked for the afternoon', meetingId: 'm1' },
];

test('history: when was a meeting moved, with sources', async () => {
  const a = await answerQuestion('When was Ford Credit × PIMCO moved?', base, { history, historySince });
  assert.equal(a.pattern, 'history');
  assert(a.answer.some((x) => /Meeting moved from email by Maya Patel/.test(x) && /Client asked/.test(x)));
  assert(a.sources.some((s) => s.kind === 'meeting' && s.id === 'm1'));
});

test('my day lists my meetings for today', async () => {
  const a = await answerQuestion("What's my day?", base, { history, historySince });
  assert.equal(a.pattern, 'my-day');
  assert(a.answer[1].includes('1:00 PM Ford Credit × PIMCO'));
  assert.equal(a.sources.length, 1);
});

test('free slots respect availability and meetings', async () => {
  const a = await answerQuestion('free slots for Ford Credit and PIMCO on Tuesday', base, { history, historySince });
  assert.equal(a.pattern, 'free-slots');
  assert.equal(a.answer.length, 1 + 6); // 9:00–12:00 in 30-minute slots
});

test('gaps: meetings without a banker or room (bankers only)', async () => {
  const a = await answerQuestion('Which meetings lack a banker or room?', base, { history, historySince });
  assert.equal(a.pattern, 'gaps');
  assert(a.answer.some((x) => x.includes('Ally Financial × Vanguard') && x.includes('no banker')));
  assert(a.answer.some((x) => x.includes('Ford Credit × PIMCO') && x.includes('no room')));
  const sales = await answerQuestion('Which meetings lack a banker?', { ...base, user: { id: 'sales-james', role: 'SALES', name: 'James' } }, { history, historySince });
  assert.equal(sales.sources.length, 0);
});

test('never acts: imperative questions are refused', async () => {
  const a = await answerQuestion('Move Ford Credit × PIMCO to 3pm', base, { history, historySince });
  assert.equal(a.pattern, 'action-refused');
});

test('sales only see their clients in history', async () => {
  const sales = { ...base, user: { id: 'sales-emma', role: 'SALES', name: 'Emma' }, visibleMeetingIds: new Set(['m2']) };
  const a = await answerQuestion('When was Ford Credit × PIMCO moved?', sales, { history, historySince });
  assert(!a.sources.length);
});

test('day words resolve inside the conference', () => {
  assert.equal(dayIn('on wednesday', base.now, zone, base.conferences[0]), '2026-11-04');
  assert.equal(dayIn('tomorrow', base.now, zone), '2026-11-04');
  assert.equal(dayIn('Nov 2', base.now, zone), '2026-11-02');
});

test('round 3: scoped questions — emails, recent changes, person, double-booking; never mismatched data', async () => {
  const deps = { history, historySince };
  const e = await answerQuestion('Which open emails are about Ford Credit?', base, deps);
  assert.equal(e.pattern, 'emails');
  assert.match(e.answer[1], /Ford Credit — PIMCO room/);
  const r = await answerQuestion('What changed on the schedule in the last 2 hours?', base, deps);
  assert.equal(r.pattern, 'recent');
  assert.match(r.answer[1], /Meeting edited \(room\): Ford Credit × PIMCO/);
  const p = await answerQuestion('Is Alex covering anything today after noon?', { ...base, user: { id: 'manager-morgan', role: 'MANAGER', name: 'Morgan' } }, deps);
  assert.equal(p.pattern, 'person-day');
  assert.match(p.answer[1], /1:00 PM Ford Credit × PIMCO/);
  const d = await answerQuestion('Is anyone double-booked today?', base, deps);
  assert.equal(d.pattern, 'double-booked');
  const u = await answerQuestion('Which investors have been moved more than twice this week?', base, deps);
  assert.equal(u.pattern, 'unsupported');
  assert.match(u.answer[0], /can't answer that yet/);
  const mine = await answerQuestion('What are my meetings today?', base, deps);
  assert.equal(mine.sources.length, 1, 'my = only meetings I cover or own');
});
