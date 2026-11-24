import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, extractionEdited, median, type MetricsInput } from '../src/lib/metrics';

const now = new Date('2026-11-03T15:00:00Z');
const h = (hoursAgo: number) => new Date(+now - hoursAgo * 3600000);
const base: MetricsInput = {
  now,
  conferences: [
    { id: 'abs', name: 'ABS East', type: 'Conference', startDate: '2026-11-02', endDate: '2026-11-04', location: 'Miami' },
    { id: 'ndr', name: 'Discover NDR — Boston', type: 'NDR', startDate: '2026-11-10', endDate: '2026-11-10', location: 'Boston' },
  ],
  issuers: [{ id: 'ford', name: 'Ford Credit', contactEmail: 'treasury@fordcredit.example' }, { id: 'discover', name: 'Discover', contactEmail: 'ir@discover.example' }],
  investors: [{ id: 'pimco', name: 'PIMCO' }, { id: 'kkr', name: 'KKR' }],
  users: [
    { id: 'alex', name: 'Alex', role: 'BANKER' },
    { id: 'sarah', name: 'Sarah', role: 'BANKER' },
    { id: 'morgan', name: 'Morgan', role: 'MANAGER' },
    { id: 'james', name: 'James', role: 'SALES' },
  ],
  requests: [
    { id: 'r1', conferenceId: 'abs', issuerId: 'ford', investorId: 'pimco', status: 'Confirmed', createdAt: h(50) },
    { id: 'r2', conferenceId: 'abs', issuerId: 'ford', investorId: 'kkr', status: 'Confirmed', createdAt: h(30) },
    { id: 'r3', conferenceId: 'abs', issuerId: 'discover', investorId: 'kkr', status: 'Confirmed', createdAt: h(20) },
    { id: 'r4', conferenceId: 'ndr', issuerId: 'discover', investorId: 'pimco', status: 'Potential Match', createdAt: h(5) },
  ],
  meetings: [
    { id: 'm1', conferenceId: 'abs', issuerId: 'ford', investorId: 'pimco', status: 'Confirmed', requestId: 'r1', bankerIds: ['alex'], start: h(-2), createdAt: h(48) }, // 2h
    { id: 'm2', conferenceId: 'abs', issuerId: 'ford', investorId: 'kkr', status: 'Confirmed', requestId: 'r2', bankerIds: ['alex', 'sarah'], start: h(-30), createdAt: h(20) }, // 10h
    { id: 'm3', conferenceId: 'abs', issuerId: 'discover', investorId: 'kkr', status: 'Confirmed', requestId: 'r3', bankerIds: [], start: h(-200), createdAt: h(16) }, // 4h
    { id: 'm4', conferenceId: 'abs', issuerId: 'discover', investorId: 'pimco', status: 'Cancelled', requestId: null, bankerIds: ['sarah'], start: h(-3), createdAt: h(10) },
  ],
  coverage: [{ meetingId: 'm3', bankerId: 'sarah' }],
  proposals: [
    { status: 'Approved', editedOnReview: false, conferenceId: 'abs', category: 'Reschedule Request' },
    { status: 'Approved', editedOnReview: false, conferenceId: 'abs', category: 'Meeting Cancellation' },
    { status: 'Approved', editedOnReview: true, conferenceId: 'abs', category: 'New Meeting Request' },
    { status: 'Rejected', editedOnReview: false, conferenceId: 'abs', category: 'New Meeting Request' },
    { status: 'Pending', editedOnReview: false, conferenceId: 'abs', category: 'New Meeting Request' },
    { status: 'Approved', editedOnReview: false, conferenceId: null, category: 'Unrelated Email' },
  ],
  actions: [
    { id: 'a1', type: 'Reschedule Request', status: 'Open', assignedTo: 'alex', createdAt: h(30), conferenceId: 'abs', title: 'Move' },
    { id: 'a2', type: 'Escalation / complaint', status: 'Acknowledged', assignedTo: 'sarah', createdAt: h(6), conferenceId: 'abs', title: 'Complaint' },
    { id: 'a3', type: 'Meeting request', status: 'Open', assignedTo: 'alex', createdAt: h(2), conferenceId: 'ndr', title: 'Req' },
    { id: 'a4', type: 'Meeting request', status: 'Resolved', assignedTo: 'sarah', createdAt: h(90), conferenceId: 'abs', title: 'Done' },
    { id: 'a5', type: 'Other', status: 'Open', assignedTo: null, createdAt: h(1), conferenceId: null, title: 'Triage' },
  ],
  emails: [
    { id: 'e1', subject: 'Ford update', sender: 'treasury@fordcredit.example', issuerId: 'ford', conferenceId: 'abs', status: 'Pending review', receivedAt: h(6), escalation: false, source: 'manual' },
    { id: 'e2', subject: 'Ford new', sender: 'treasury@fordcredit.example', issuerId: 'ford', conferenceId: 'abs', status: 'Pending review', receivedAt: h(2), escalation: false, source: 'manual' },
    { id: 'e3', subject: 'Via sales', sender: 'james.wilson@conferenceos.demo', issuerId: 'ford', conferenceId: 'abs', status: 'Pending review', receivedAt: h(9), escalation: false, source: 'manual' },
    { id: 'e4', subject: 'Answered', sender: 'ir@discover.example', issuerId: 'discover', conferenceId: 'abs', status: 'Approved', receivedAt: h(40), escalation: false, source: 'demo-history' },
    { id: 'e5', subject: 'Asked back', sender: 'ir@discover.example', issuerId: 'discover', conferenceId: 'abs', status: 'Clarification requested', receivedAt: h(40), escalation: false, source: 'demo-history' },
  ],
};

test('fill rate and median time-to-confirm come from requests and meetings', () => {
  const m = computeMetrics(base);
  assert.equal(m.totals.requested, 4);
  assert.equal(m.totals.confirmed, 3);
  assert.equal(m.totals.rate, 0.75);
  assert.equal(m.totals.medianHoursToConfirm, 4); // 2h, 4h, 10h
  assert.equal(m.totals.meetings, 3, 'cancelled meetings do not count');
  const abs = m.events.find((e) => e.id === 'abs')!;
  assert.deepEqual([abs.state, abs.meetings, abs.requested, abs.confirmed, abs.openItems], ['Live', 3, 3, 3, 2]);
  assert.deepEqual(m.events.map((e) => e.type), ['Conference', 'NDR']);
  assert.equal(m.events[1].state, 'Upcoming');
});

test('emails handled: approved as read vs edited vs rejected (unrelated mail excluded)', () => {
  const m = computeMetrics(base);
  assert.deepEqual(m.emails, { approvedClean: 2, approvedEdited: 1, rejected: 1, rejectedNoise: 0, declined: 1, pending: 1 });
  assert.deepEqual(m.roi, { asksHandled: 5, minutesPerAsk: 6, hoursSaved: 0.5 });
});

test('open items per coordinator with the oldest age; escalations; workload', () => {
  const m = computeMetrics(base);
  assert.deepEqual(m.openByCoordinator.map((o) => [o.name, o.open, o.oldestHours]), [['Alex', 2, 30], ['Sarah', 1, 6], ['Unassigned', 1, 1]]);
  assert.equal(m.totals.escalationsOpen, 1);
  assert.equal(m.escalations[0].owner, 'Sarah');
  const sarah = m.workload.find((w) => w.userId === 'sarah')!;
  assert.deepEqual([sarah.meetings, sarah.openItems], [2, 1], 'bankerIds and coverage both count; cancelled not');
  assert(!m.workload.some((w) => w.userId === 'james'), 'sales are not desk workload');
  assert(!m.workload.some((w) => w.userId === 'morgan'), 'the manager is not coordinator workload');
});

test('unanswered issuer emails: from the issuer, waiting on us, older than 4 hours', () => {
  const m = computeMetrics(base);
  assert.deepEqual(m.unanswered.map((u) => [u.id, u.ageHours]), [['e1', 6]]);
  assert.equal(m.demoRecords, 2);
});

test('per issuer / investor counts; median helper; edit detection', () => {
  const m = computeMetrics(base);
  assert.deepEqual(m.perIssuer.map((p) => [p.name, p.meetings, p.requested]), [['Ford Credit', 2, 2], ['Discover', 1, 2]]);
  assert.equal(median([]), null);
  assert.equal(median([1, 2, 3, 10]), 2.5);
  const a = { category: 'Reschedule Request', operation: 'reschedule', issuerId: 'ford', investorId: 'pimco', windows: [{ start: 'x', end: 'y', kind: 'availability', evidence: 'a' }] };
  assert.equal(extractionEdited(a, { ...a, meetingId: 'm1', windows: [{ ...a.windows[0], evidence: 'b' }] }), false);
  assert.equal(extractionEdited(a, { ...a, windows: [{ ...a.windows[0], start: 'z' }] }), true);
});

test('pending meetings: three stages, counted once, a move is not also confirmed; targets are the fewest confirmed', async () => {
  const { pendingMeetings, computeMetrics } = await import('../src/lib/metrics');
  const now = new Date('2026-11-23T15:00:00Z');
  const issuers = [
    { id: 'ford', name: 'Ford Credit', contactEmail: 'ir@ford.example' },
    { id: 'ally', name: 'Ally', contactEmail: 'ir@ally.example' },
    { id: 'gmf', name: 'GM Financial', contactEmail: 'ir@gmf.example' },
    { id: 'bay', name: 'Bayview', contactEmail: 'ir@bay.example' },
  ];
  const meetings = [
    { id: 'm1', conferenceId: 'c', issuerId: 'ford', investorId: 'pimco', status: 'Confirmed', requestId: null, bankerIds: [], start: now, createdAt: now },
    { id: 'm2', conferenceId: 'c', issuerId: 'ford', investorId: 'wel', status: 'Confirmed', requestId: null, bankerIds: [], start: now, createdAt: now },
    { id: 'm3', conferenceId: 'c', issuerId: 'ally', investorId: 'pimco', status: 'Confirmed', requestId: null, bankerIds: [], start: now, createdAt: now },
  ];
  const requests = [
    { id: 'r1', conferenceId: 'c', issuerId: 'gmf', investorId: 'apollo', status: 'Potential Match', createdAt: now },
    { id: 'r2', conferenceId: 'c', issuerId: 'ally', investorId: 'blk', status: 'Potential Match', createdAt: now },
    { id: 'r3', conferenceId: 'c', issuerId: 'ford', investorId: 'blk', status: 'Confirmed', createdAt: now },
  ];
  const proposals = [
    // Ford moves Wellington, sales was asked → stage 2 waiting on the investor
    { id: 'p1', emailId: 'e1', status: 'Pending', editedOnReview: false, conferenceId: 'c', category: 'Reschedule Request', issuerId: 'ford', investorId: 'wel', sender: 'ir@ford.example', receivedAt: now },
    // Ally says yes to BlackRock → the sales request moves to stage 3
    { id: 'p2', emailId: 'e2', status: 'Pending', editedOnReview: false, conferenceId: 'c', category: 'Meeting Confirmation', issuerId: 'ally', investorId: 'blk', sender: 'ir@ally.example', receivedAt: now },
  ];
  const actions = [{ id: 'a1', type: 'Sales check', status: 'Open', assignedTo: 's', createdAt: now, conferenceId: 'c', title: '', proposalId: 'p1' }];
  const p = pendingMeetings({ requests, meetings, proposals, actions, issuers });
  assert.equal(p.items.length, 3);
  assert.deepEqual(p.items.map((i) => [i.issuerId, i.stage, i.waitingOn]), [['gmf', 1, 'Issuer'], ['ford', 2, 'Investor'], ['ally', 3, 'Desk']]);
  assert.equal(p.confirmed.length, 2, 'Ford × Wellington is being moved, so it is pending, not confirmed');
  const m = computeMetrics({
    now,
    conferences: [{ id: 'c', name: 'ABS', type: 'Conference', startDate: '2026-12-08', endDate: '2026-12-10', location: '' }],
    issuers, investors: [], users: [], requests, meetings, coverage: [], proposals, actions, emails: [],
    availability: issuers.map((i) => ({ conferenceId: 'c', issuerId: i.id })),
    openSlots: { bay: 12 },
  });
  assert.deepEqual([m.meetings.confirmed, m.meetings.pending, m.meetings.total], [2, 3, 5]);
  assert.deepEqual(m.issuerRanking.map((r) => r.id), ['ally', 'ford', 'gmf', 'bay']);
  assert.deepEqual(m.targets.map((r) => r.id), ['bay', 'gmf', 'ally']);
  assert.equal(m.targets[0].openSlots, 12);
});
