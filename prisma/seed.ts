import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { formatInTimeZone } from 'date-fns-tz';
import { mockExtractAsks, newEmailContent } from '../src/lib/extraction';
import { conferenceTime, evaluate, mergeWindows, overlaps } from '../src/lib/scheduling';
import { now } from '../src/lib/clock';
const db = new PrismaClient();
/**
 * Live-demo seed. "Now" is server time (or DEMO_NOW). ABS East runs yesterday–tomorrow, so the
 * conference is mid-event: some of today's meetings already happened, the rest are upcoming, and
 * every open item is about a future time. Meetings are staggered around the current hour, staffed
 * by an approved allocation run, and each banker has a handful of meetings today and tomorrow.
 *
 * Re-running is safe (existing rows are kept). DEMO_RESEED=true wipes the demo tables (everything
 * except users and Outlook links) first: use it to refresh a long-lived database such as Neon.
 * DEMO_FIXED_DATES=true keeps the old fixed October dates for screenshots that need them.
 */
const ZONE = 'America/New_York';
const NOW = now();
const ymd = (d: Date) => formatInTimeZone(d, ZONE, 'yyyy-MM-dd');
const shift = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const TODAY = process.env.DEMO_FIXED_DATES === 'true' ? '2026-10-20' : ymd(NOW);
const DAYS = { Y: shift(TODAY, -1), T: TODAY, M: shift(TODAY, 1) };
const hhmm = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
/** Today's meetings are placed around the current half hour (kept within 10:30–15:30). */
const ANCHOR = (() => {
  const [h, m] = formatInTimeZone(NOW, ZONE, 'H:m').split(':').map(Number);
  return Math.min(15 * 60 + 30, Math.max(10 * 60 + 30, h * 60 + (m >= 30 ? 30 : 0)));
})();
const at = (day: string, mins: number) => conferenceTime(day, hhmm(mins), ZONE);
const weekday = (day: string) => formatInTimeZone(new Date(`${day}T17:00:00Z`), 'UTC', 'EEEE');
const ago = (hours: number) => new Date(+NOW - hours * 3600000);

const users = [
  { id: 'banker-alex', name: 'Alex Morgan', email: 'alex.morgan@conferenceos.demo', role: 'BANKER' },
  { id: 'banker-sarah', name: 'Sarah Chen', email: 'sarah.chen@conferenceos.demo', role: 'BANKER' },
  { id: 'banker-maya', name: 'Maya Patel', email: 'maya.patel@conferenceos.demo', role: 'BANKER' },
  { id: 'banker-daniel', name: 'Daniel Kim', email: 'daniel.kim@conferenceos.demo', role: 'BANKER' },
  { id: 'banker-priya', name: 'Priya Shah', email: 'priya.shah@conferenceos.demo', role: 'BANKER' },
  { id: 'banker-michael', name: 'Michael Torres', email: 'michael.torres@conferenceos.demo', role: 'BANKER' },
  { id: 'banker-lauren', name: 'Lauren Brooks', email: 'lauren.brooks@conferenceos.demo', role: 'BANKER' },
  { id: 'banker-david', name: 'David Lin', email: 'david.lin@conferenceos.demo', role: 'BANKER' },
  { id: 'sales-james', name: 'James Wilson', email: 'james.wilson@conferenceos.demo', role: 'SALES' },
  { id: 'sales-emma', name: 'Emma Davis', email: 'emma.davis@conferenceos.demo', role: 'SALES' },
  { id: 'manager-morgan', name: 'Morgan Lee', email: 'morgan.lee@conferenceos.demo', role: 'MANAGER' },
];
const BANKERS = users.filter((u) => u.role === 'BANKER').map((u) => u.id);
const investors = [
  { id: 'pimco', name: 'PIMCO', contactEmail: 'meetings@pimco.example' },
  { id: 'blackrock', name: 'BlackRock', contactEmail: 'meetings@blackrock.example' },
  { id: 'wellington', name: 'Wellington Management', contactEmail: 'meetings@wellington.example' },
  { id: 'fidelity', name: 'Fidelity', contactEmail: 'meetings@fidelity.example' },
  { id: 'apollo', name: 'Apollo', contactEmail: 'meetings@apollo.example' },
  { id: 'metlife', name: 'MetLife', contactEmail: 'meetings@metlife.example' },
  { id: 'prudential', name: 'Prudential', contactEmail: 'meetings@prudential.example' },
  { id: 'pgim', name: 'PGIM', contactEmail: 'meetings@pgim.example' },
  { id: 'vanguard', name: 'Vanguard', contactEmail: 'meetings@vanguard.example' },
  { id: 'ares', name: 'Ares Management', contactEmail: 'meetings@ares.example' },
  { id: 'kkr', name: 'KKR', contactEmail: 'meetings@kkr.example' },
  { id: 'nuveen', name: 'Nuveen', contactEmail: 'meetings@nuveen.example' },
  { id: 'trowe', name: 'T. Rowe Price', contactEmail: 'meetings@trowe.example' },
  { id: 'invesco', name: 'Invesco', contactEmail: 'meetings@invesco.example' },
];
const JAMES = ['pimco', 'blackrock', 'wellington', 'fidelity', 'apollo'];
const cubes = [
  { id: 'cube-1', name: 'Meeting Cube 1', capacity: 4, location: 'Ocean Tower · Level 2' },
  { id: 'cube-2', name: 'Meeting Cube 2', capacity: 6, location: 'Ocean Tower · Level 2' },
  { id: 'cube-3', name: 'Meeting Cube 3', capacity: 6, location: 'Ocean Tower · Level 2' },
  { id: 'cube-4', name: 'Meeting Cube 4', capacity: 8, location: 'Tresor · Level 1' },
  { id: 'cube-5', name: 'Boardroom', capacity: 14, location: 'Tresor · Level 1' },
];
const A = (offset: number) => ANCHOR + offset;
/** [day, start (minutes), issuer, investor, attendees, bankers needed] — staggered, never 7 at once. */
const MEETINGS: [keyof typeof DAYS, number, string, string, number, number][] = [
  ['Y', 540, 'ford', 'blackrock', 6, 2], ['Y', 570, 'ally', 'metlife', 4, 1], ['Y', 630, 'santander', 'wellington', 5, 2],
  ['Y', 660, 'discover', 'kkr', 4, 1], ['Y', 780, 'athene', 'apollo', 5, 2], ['Y', 840, 'gmf', 'pgim', 4, 1],
  ['Y', 900, 'bayview', 'pimco', 6, 2], ['Y', 930, 'newrez', 'vanguard', 4, 1],
  ['T', A(-180), 'capital-one', 'prudential', 4, 1], ['T', A(-150), 'ford', 'pimco', 6, 2], ['T', A(-120), 'rocket', 'ares', 4, 1],
  ['T', A(-90), 'athene', 'fidelity', 5, 2], ['T', A(-60), 'penny', 'nuveen', 4, 1], ['T', A(-30), 'bayview', 'wellington', 6, 2],
  ['T', A(0), 'onemain', 'trowe', 4, 1], ['T', A(30), 'discover', 'blackrock', 6, 2], ['T', A(60), 'ally', 'invesco', 4, 1],
  ['T', A(90), 'santander', 'fidelity', 5, 2], ['T', A(120), 'gmf', 'apollo', 4, 1], ['T', A(150), 'newrez', 'kkr', 4, 2],
  ['T', A(180), 'rocket', 'metlife', 4, 1], ['T', A(210), 'capital-one', 'pimco', 5, 2],
  ['M', 540, 'ally', 'pimco', 5, 2], ['M', 570, 'onemain', 'vanguard', 8, 2], ['M', 600, 'ford', 'wellington', 5, 1],
  ['M', 630, 'bayview', 'ares', 4, 2], ['M', 660, 'discover', 'fidelity', 4, 1], ['M', 690, 'santander', 'apollo', 6, 2],
  ['M', 780, 'gmf', 'metlife', 4, 1], ['M', 810, 'bayview', 'pimco', 5, 1], ['M', 840, 'penny', 'prudential', 4, 2],
  ['M', 900, 'ford', 'blackrock', 10, 2], ['M', 930, 'newrez', 'invesco', 4, 1], ['M', 960, 'rocket', 'kkr', 4, 2],
  ['M', 990, 'capital-one', 'trowe', 4, 1],
];
/** Issuer availability is specific per issuer (not everyone 9–5); meetings are always inside it. */
const TEMPLATES: [number, number][][] = [
  [[540, 720], [810, 1020]], [[510, 690], [840, 990]], [[600, 900]], [[540, 780]], [[570, 750], [780, 960]], [[660, 1020]],
];

async function wipeDemo() {
  // Order matters only for readability: there are no foreign keys between these tables except Meeting → Request.
  await db.$transaction([
    db.notification.deleteMany(), db.askLog.deleteMany(), db.auditLog.deleteMany(), db.exportLog.deleteMany(),
    db.draft.deleteMany(), db.action.deleteMany(), db.proposal.deleteMany(), db.email.deleteMany(),
    db.allocationProposal.deleteMany(), db.allocationRun.deleteMany(), db.meetingCoverageAssignment.deleteMany(),
    db.meetingCubeAssignment.deleteMany(), db.meetingCoverageRequirement.deleteMany(), db.bankerPreference.deleteMany(),
    db.bankerAvailability.deleteMany(), db.cubeAvailability.deleteMany(), db.meetingCube.deleteMany(),
    db.issuerCoverageAuthorization.deleteMany(), db.meeting.deleteMany(), db.meetingRequest.deleteMany(),
    db.availability.deleteMany(), db.investor.deleteMany(), db.issuer.deleteMany(), db.conference.deleteMany(),
  ]);
}

async function main() {
  if (process.env.DEMO_RESEED === 'true') {
    await wipeDemo();
    console.log('Demo tables wiped (users and Outlook links kept).');
  } else {
    const existing = await db.conference.findUnique({ where: { id: 'abs-east' } });
    if (existing && existing.startDate !== DAYS.Y)
      console.warn(`ABS East already seeded for ${existing.startDate}; run with DEMO_RESEED=true to move the demo to today.`);
  }
  for (const u of users) await db.user.upsert({ where: { id: u.id }, create: u, update: { name: u.name, role: u.role } });
  const conferences = [
    { id: 'abs-east', name: 'ABS East 2026', location: 'Fontainebleau · Miami Beach', timezone: ZONE, startDate: DAYS.Y, endDate: DAYS.M, slotMinutes: 30, roomBufferMinutes: 0, preferenceDeadline: at(DAYS.Y, 0), type: 'Conference' },
    { id: 'discover-ndr', name: 'Discover NDR — Boston', location: 'Boston, MA', timezone: ZONE, startDate: shift(TODAY, 7), endDate: shift(TODAY, 7), slotMinutes: 60, type: 'NDR' },
    { id: 'sf-vegas', name: 'Structured Finance Summit', location: 'Las Vegas, Nevada', timezone: 'America/Los_Angeles', startDate: shift(TODAY, 13), endDate: shift(TODAY, 15), slotMinutes: 30, type: 'Conference' },
  ];
  for (const c of conferences) await db.conference.upsert({ where: { id: c.id }, create: c, update: {} });
  const issuers = [
    {
      id: 'bayview',
      name: 'Bayview',
      sector: 'Residential credit',
      color: '#5c7cbd',
      contactEmail: 'ir@bayview.example',
      ownerId: 'banker-alex',
    },
    {
      id: 'ford',
      name: 'Ford Credit',
      sector: 'Auto ABS',
      color: '#4f8b7a',
      contactEmail: 'treasury@fordcredit.example',
      ownerId: 'banker-sarah',
    },
    {
      id: 'santander',
      name: 'Santander',
      sector: 'Consumer ABS',
      color: '#b86a65',
      contactEmail: 'ir@santander.example',
      ownerId: 'banker-alex',
    },
    {
      id: 'athene',
      name: 'Athene',
      sector: 'Insurance & annuities',
      color: '#9a78b6',
      contactEmail: 'ir@athene.example',
      ownerId: 'banker-sarah',
    },
    {
      id: 'onemain',
      name: 'OneMain Financial',
      sector: 'Consumer credit',
      color: '#be9353',
      contactEmail: 'ir@onemain.example',
      ownerId: 'banker-alex',
    },
    {
      id: 'penny',
      name: 'PennyMac',
      sector: 'Mortgage finance',
      color: '#6d8e9b',
      contactEmail: 'ir@pennymac.example',
      ownerId: 'banker-daniel',
    },
    { id: 'ally', name: 'Ally Financial', sector: 'Auto finance', color: '#4f77a8', contactEmail: 'ir@ally.example', ownerId: 'banker-maya' },
    { id: 'capital-one', name: 'Capital One', sector: 'Consumer finance', color: '#7a65a8', contactEmail: 'ir@capitalone.example', ownerId: 'banker-priya' },
    { id: 'gmf', name: 'GM Financial', sector: 'Auto ABS', color: '#3f7890', contactEmail: 'ir@gmfinancial.example', ownerId: 'banker-michael' },
    { id: 'newrez', name: 'NewRez', sector: 'Mortgage finance', color: '#9b7355', contactEmail: 'ir@newrez.example', ownerId: 'banker-lauren' },
    { id: 'rocket', name: 'Rocket Mortgage', sector: 'Mortgage finance', color: '#b25e72', contactEmail: 'ir@rocket.example', ownerId: 'banker-david' },
    { id: 'discover', name: 'Discover', sector: 'Credit cards', color: '#56826d', contactEmail: 'ir@discover.example', ownerId: 'banker-sarah' },
  ];
  for (const i of issuers) await db.issuer.upsert({ where: { id: i.id }, create: i, update: {} });
  for (const i of investors)
    await db.investor.upsert({ where: { id: i.id }, create: { ...i, coverageSalesId: JAMES.includes(i.id) ? 'sales-james' : 'sales-emma' }, update: {} });
  if (await db.meeting.findFirst({ where: { conferenceId: 'abs-east' } })) {
    console.log('ABS East already has meetings; kept as they are.');
    return;
  }
  // Cubes, banker and cube availability (8:00–19:00 every day).
  for (const c of cubes) await db.meetingCube.create({ data: { ...c, conferenceId: 'abs-east' } });
  for (const day of Object.values(DAYS)) {
    for (const b of BANKERS) await db.bankerAvailability.create({ data: { conferenceId: 'abs-east', bankerId: b, start: at(day, 480), end: at(day, 1140) } });
    for (const c of cubes) await db.cubeAvailability.create({ data: { cubeId: c.id, start: at(day, 480), end: at(day, 1140) } });
  }
  // Meetings, staffed and roomed without double-booking anyone.
  const booked: { who: string; start: Date; end: Date }[] = [];
  const free = (who: string, start: Date, end: Date) => !booked.some((b) => b.who === who && overlaps(b, { start, end }));
  const load = new Map<string, number>();
  const created: { id: string; issuerId: string; investorId: string; start: Date; end: Date; bankers: string[]; cube: string; day: string; attendees: number }[] = [];
  for (const [k, [dayKey, mins, issuerId, investorId, attendees, needed]] of MEETINGS.entries()) {
    const day = DAYS[dayKey];
    const start = at(day, mins), end = at(day, mins + 30);
    const owner = issuers.find((i) => i.id === issuerId)!.ownerId!;
    const live = dayKey !== 'Y';
    const byLoad = [...BANKERS].sort((a, b) => (load.get(a) || 0) - (load.get(b) || 0) || a.localeCompare(b));
    const primary = free(owner, start, end) && (load.get(owner) || 0) < 6 ? owner : byLoad.find((b) => free(b, start, end))!;
    const bankers = [primary];
    if (needed > 1) bankers.push(byLoad.find((b) => b !== primary && free(b, start, end))!);
    for (const b of bankers) {
      booked.push({ who: b, start, end });
      if (live) load.set(b, (load.get(b) || 0) + 1);
    }
    const cube = cubes.filter((c) => c.capacity >= attendees).sort((a, b) => a.capacity - b.capacity).find((c) => free(c.id, start, end))!;
    booked.push({ who: cube.id, start, end });
    const id = `seed-meeting-${k}`;
    await db.meeting.create({
      data: { id, conferenceId: 'abs-east', issuerId, investorId, start, end, location: `${cube.name} · ${cube.location}`, bankerIds: bankers, expectedAttendees: attendees, requiresCube: true, approvedBy: owner, approvedRecipients: [], createdAt: ago(96 + k) },
    });
    await db.meetingCoverageRequirement.create({ data: { meetingId: id, requiredBankerCount: needed, requiredPrimaryCount: 1 } });
    for (const [r, b] of bankers.entries()) {
      await db.meetingCoverageAssignment.create({ data: { meetingId: id, bankerId: b, coverageRole: r === 0 ? 'Primary' : 'Support', assignmentStatus: 'Approved', assignedBy: 'banker-sarah' } });
      await db.issuerCoverageAuthorization.upsert({
        where: { conferenceId_bankerId_issuerId: { conferenceId: 'abs-east', bankerId: b, issuerId } },
        create: { conferenceId: 'abs-east', bankerId: b, issuerId, qualification: b === owner || r === 0 ? 'Primary' : 'Support' },
        update: {},
      });
    }
    await db.meetingCubeAssignment.create({ data: { meetingId: id, cubeId: cube.id, assignmentStatus: 'Approved', assignedBy: 'banker-sarah' } });
    created.push({ id, issuerId, investorId, start, end, bankers, cube: cube.id, day, attendees });
  }
  for (const i of issuers)
    await db.issuerCoverageAuthorization.upsert({
      where: { conferenceId_bankerId_issuerId: { conferenceId: 'abs-east', bankerId: i.ownerId!, issuerId: i.id } },
      create: { conferenceId: 'abs-east', bankerId: i.ownerId!, issuerId: i.id, qualification: 'Primary' },
      update: {},
    });
  // The approved allocation run that staffed them.
  await db.allocationRun.create({
    data: { id: 'seed-allocation-run', conferenceId: 'abs-east', algorithmVersion: 'conferenceos-deterministic-v1', runTimestamp: ago(40), runStatus: 'Approved', createdBy: 'banker-sarah', approvedBy: 'banker-sarah', approvedAt: ago(39), summary: { meetings: created.length, fullyAllocated: created.length } },
  });
  for (const m of created)
    await db.allocationProposal.create({ data: { allocationRunId: 'seed-allocation-run', meetingId: m.id, proposedBankerIds: m.bankers, proposedCubeId: m.cube, validationStatus: 'Valid', explanation: 'All hard constraints satisfied.' } });
  // Issuer availability: a per-issuer pattern, widened only where a booked meeting needs it.
  for (const [ix, issuer] of issuers.entries())
    for (const [dx, day] of Object.values(DAYS).entries()) {
      const tpl = TEMPLATES[(ix + dx) % TEMPLATES.length].map(([s, e]) => ({ start: at(day, s), end: at(day, e) }));
      for (const m of created.filter((x) => x.issuerId === issuer.id && x.day === day))
        if (!tpl.some((w) => +w.start <= +m.start && +w.end >= +m.end)) tpl.push({ start: new Date(+m.start - 3600000), end: new Date(+m.end + 3600000) });
      for (const w of mergeWindows(tpl))
        await db.availability.create({ data: { conferenceId: 'abs-east', issuerId: issuer.id, start: new Date(w.start), end: new Date(w.end), approvedBy: issuer.ownerId! } });
    }
  // Open requests, all for tomorrow.
  const reqs: [string, string, string, number, 'High' | 'Normal'][] = [
    ['athene', 'blackrock', 'sales-james', 660, 'High'],
    ['discover', 'wellington', 'sales-james', 810, 'Normal'],
    ['penny', 'apollo', 'sales-james', 870, 'Normal'],
    ['santander', 'metlife', 'sales-emma', 900, 'Normal'],
  ];
  for (const [k, [issuerId, investorId, salespersonId, mins, priority]] of reqs.entries()) {
    const issuer = issuers.find((i) => i.id === issuerId)!;
    const start = at(DAYS.M, mins), end = at(DAYS.M, mins + 30);
    const windows = await db.availability.findMany({ where: { conferenceId: 'abs-east', issuerId, kind: 'Available' } });
    const busy = await db.meeting.findMany({ where: { conferenceId: 'abs-east', OR: [{ issuerId }, { investorId }] } });
    const status = evaluate({ start, end }, windows, busy, 30, 30).status;
    const id = `seed-request-${k}`;
    await db.meetingRequest.create({ data: { id, conferenceId: 'abs-east', issuerId, investorId, salespersonId, bankerId: issuer.ownerId, start, end, duration: 30, alternativeDates: [], notes: 'One-on-one requested by the investment team.', priority, status, createdAt: ago(20 - k * 3) } });
    await db.action.create({ data: { type: 'Meeting request', title: `New investor request · ${issuer.name}`, conferenceId: 'abs-east', issuerId, investorId, requestId: id, assignedTo: issuer.ownerId, priority, recommendation: 'Check availability and obtain issuer consent.', createdAt: ago(20 - k * 3) } });
  }
  await seedQueueEmails(issuers);
  await seedNdr();
  await seedDemoHistory(issuers, conferences, created);
  const perBanker = BANKERS.map((b) => created.filter((m) => m.day !== DAYS.Y && m.bankers.includes(b)).length);
  console.log(`Seed complete. ABS East ${DAYS.Y}…${DAYS.M} (today ${TODAY}, anchor ${hhmm(ANCHOR)} ET): ${created.length} meetings, bankers have ${Math.min(...perBanker)}–${Math.max(...perBanker)} meetings today/tomorrow; NDR and SF Summit later.`);
}

/** Queue items for the demo: all about tomorrow. */
async function seedQueueEmails(issuers: { id: string; name: string; contactEmail: string; ownerId: string | null }[]) {
  const TW = weekday(DAYS.M);
  const conferences = [{ id: 'abs-east', name: 'ABS East 2026', startDate: DAYS.Y, endDate: DAYS.M, timezone: ZONE }];
  const samples = [
    { id: 'bayview-update', issuerId: 'bayview', subject: `ABS East — ${TW} availability`, body: `Hi Alex,\n\nFor ${TW} at ABS East 2026 Bayview is available between 1 PM and 4 PM only (our CEO is on a rating-agency call in the morning).\n\nBest,\nDana` },
    { id: 'ford-reschedule', issuerId: 'ford', subject: 'ABS East 2026 — Wellington meeting', body: `Hi Sarah,\n\nCould we move the Ford Credit meeting with Wellington Management on ${TW} from 10:00 AM to 11:30 AM? Our treasurer lands at 10.\n\nThank you,\nMike` },
    { id: 'santander-confirm', issuerId: 'santander', subject: 'ABS East 2026 — MetLife', body: `Hi Alex,\n\nSantander confirms the MetLife meeting on ${TW} at 3:00 PM at ABS East 2026. Two of us will attend.\n\nBest,\nMaria` },
    { id: 'rocket-cancel', issuerId: 'rocket', subject: 'ABS East 2026 — KKR', body: `Hi David,\n\nPlease cancel the Rocket Mortgage meeting with KKR on ${TW} at 4:00 PM. Our CFO has to fly back early.\n\nThanks,\nEmily` },
  ];
  for (const s of samples) {
    const { asks } = mockExtractAsks(s.body, s.subject, { conferences, issuers, investors }, { conferenceId: 'abs-east', issuerId: s.issuerId });
    const issuer = issuers.find((i) => i.id === s.issuerId)!;
    const mail = await db.email.create({
      data: { messageId: s.id, threadId: `thread-${s.id}`, sender: issuer.contactEmail, to: [users.find((u) => u.id === issuer.ownerId)!.email], cc: [], subject: s.subject, body: s.body, newContent: newEmailContent(s.body), conferenceId: 'abs-east', issuerId: s.issuerId, investorId: asks.length === 1 ? asks[0].investorId : null, category: asks.length === 1 ? asks[0].category : 'Multiple asks', senderStatus: 'verified', receivedAt: ago(1.5) },
    });
    for (const [askIndex, e] of asks.entries()) {
      const proposal = await db.proposal.create({ data: { emailId: mail.id, askIndex, summary: e.summary, extraction: e, createdAt: ago(1.5) } });
      await db.action.create({ data: { type: e.category, title: `${issuer.name} · ${e.summary}`, conferenceId: 'abs-east', issuerId: s.issuerId, investorId: e.investorId, emailId: mail.id, proposalId: proposal.id, assignedTo: issuer.ownerId, priority: 'Normal', recommendation: e.uncertainties[0] || 'Review the extracted request and its evidence.', createdAt: ago(1.5) } });
    }
  }
  // An escalation about an upcoming meeting; the meeting is protected.
  const target = await db.meeting.findFirst({ where: { conferenceId: 'abs-east', issuerId: 'santander', investorId: 'apollo' } });
  if (target) {
    const when = formatInTimeZone(target.start, ZONE, 'EEEE h:mm a');
    const text = `This is the third time the Santander meeting has moved. Please HOLD ${when} and do not move it again; if it moves we will pass.`;
    const esc = await db.email.create({ data: { messageId: 'seed-escalation', threadId: 'seed-escalation', sender: 'meetings@apollo.example', to: ['alex.morgan@conferenceos.demo'], cc: [], subject: 'Santander — please do not move again', body: `Alex,\n\n${text}\n\nGreg | Apollo`, newContent: text, receivedAt: ago(2), conferenceId: 'abs-east', investorId: 'apollo', issuerId: 'santander', category: 'Escalation / complaint', status: 'Pending review', senderStatus: 'verified', escalation: true, escalationReasons: ['Threat to drop the meeting'] } });
    const ask = mockExtractAsks(text, esc.subject, { conferences, issuers, investors }, { conferenceId: 'abs-east' }).asks[0];
    const p = await db.proposal.create({ data: { emailId: esc.id, askIndex: 0, summary: `Apollo: hold Santander × Apollo ${when}, do not move again`, extraction: { ...ask, category: 'Escalation / complaint', operation: 'escalate', issuerId: 'santander', investorId: 'apollo', meetingId: target.id }, createdAt: ago(2) } });
    await db.action.create({ data: { type: 'Escalation / complaint', title: `Apollo · hold Santander × Apollo ${when}`, conferenceId: 'abs-east', issuerId: 'santander', investorId: 'apollo', emailId: esc.id, proposalId: p.id, meetingId: target.id, assignedTo: 'banker-alex', priority: 'Urgent', recommendation: 'Call Apollo; the meeting is protected — do not move it without their agreement.', createdAt: ago(2) } });
    await db.meeting.update({ where: { id: target.id }, data: { protected: true, protectedReason: 'Apollo: "do not move it again; if it moves we will pass"', protectedBy: 'banker-alex' } });
  }
}

/** Discover NDR — Boston: one day of investor meetings next week. */
async function seedNdr() {
  const day = shift(TODAY, 7);
  await db.availability.create({ data: { conferenceId: 'discover-ndr', issuerId: 'discover', start: at(day, 510), end: at(day, 1020), approvedBy: 'banker-sarah' } });
  const rows: [string, number, string][] = [['pimco', 540, 'Hotel Commonwealth · Suite 4'], ['blackrock', 630, 'BlackRock Boston office'], ['wellington', 780, 'Wellington · 280 Congress St']];
  for (const [i, [investorId, mins, location]] of rows.entries()) {
    const requestId = `ndr-request-${i}`;
    const createdAt = ago(60 - i * 12);
    await db.meetingRequest.create({ data: { id: requestId, conferenceId: 'discover-ndr', issuerId: 'discover', investorId, salespersonId: 'sales-james', bankerId: 'banker-sarah', start: at(day, mins), end: at(day, mins + 60), duration: 60, alternativeDates: [], notes: 'NDR one-on-one', priority: 'Normal', status: 'Confirmed', createdAt } });
    await db.meeting.create({ data: { id: `ndr-meeting-${i}`, requestId, conferenceId: 'discover-ndr', issuerId: 'discover', investorId, start: at(day, mins), end: at(day, mins + 60), location, bankerIds: ['banker-sarah'], approvedBy: 'banker-sarah', approvedRecipients: [], expectedAttendees: 3, requiresCube: false, createdAt: new Date(+createdAt + (3 + i * 5) * 3600000) } });
  }
  await db.meetingRequest.create({ data: { id: 'ndr-request-open', conferenceId: 'discover-ndr', issuerId: 'discover', investorId: 'kkr', salespersonId: 'sales-emma', bankerId: 'banker-sarah', start: at(day, 900), end: at(day, 960), duration: 60, alternativeDates: [], notes: 'KKR would like the afternoon slot', priority: 'High', status: 'Potential Match', createdAt: ago(20) } });
}

/**
 * Earlier activity (marked: emails have source "demo-history") so team metrics have real records:
 * requests confirmed over the past days and issuer emails approved, edited or rejected.
 */
async function seedDemoHistory(
  issuers: { id: string; name: string; contactEmail: string; ownerId: string | null }[],
  conferences: { id: string; name: string; startDate: string; endDate: string; timezone: string }[],
  created: { id: string; issuerId: string; investorId: string; start: Date; end: Date }[],
) {
  const delays = [2, 5, 26, 3, 8, 30, 4, 12, 6, 18, 2.5, 9, 7, 3.5, 11, 5];
  for (const [k, m] of created.slice(0, 16).entries()) {
    const createdAt = ago(150 - k * 6);
    const requestId = `history-request-${k}`;
    await db.meetingRequest.create({ data: { id: requestId, conferenceId: 'abs-east', issuerId: m.issuerId, investorId: m.investorId, salespersonId: JAMES.includes(m.investorId) ? 'sales-james' : 'sales-emma', bankerId: issuers.find((i) => i.id === m.issuerId)?.ownerId || null, start: m.start, end: m.end, duration: 30, alternativeDates: [], notes: 'Confirmed before the event', priority: 'Normal', status: 'Confirmed', createdAt } });
    await db.meeting.update({ where: { id: m.id }, data: { requestId, createdAt: new Date(+createdAt + delays[k] * 3600000) } });
  }
  // 2. Issuer emails reviewed over the past days.
  const history: { issuerId: string; body: string; status: 'Approved' | 'Rejected' | 'Pending'; edited?: boolean; hoursAgo: number; reviewer: string; note?: string }[] = [
    { issuerId: 'ford', body: 'Ford Credit is available Monday between 1 PM and 4 PM for ABS East 2026.', status: 'Approved', hoursAgo: 120, reviewer: 'banker-sarah' },
    { issuerId: 'ally', body: 'Ally Financial is available Tuesday between 9 AM and 12 PM for ABS East 2026.', status: 'Approved', hoursAgo: 110, reviewer: 'banker-maya' },
    { issuerId: 'santander', body: 'Santander is available Wednesday between 10 AM and 2 PM for ABS East 2026.', status: 'Approved', hoursAgo: 100, reviewer: 'banker-alex' },
    { issuerId: 'athene', body: 'Athene is available Monday between 9 AM and 11 AM for ABS East 2026.', status: 'Approved', hoursAgo: 96, reviewer: 'banker-sarah' },
    { issuerId: 'gmf', body: 'GM Financial is available Tuesday between 1 PM and 5 PM for ABS East 2026.', status: 'Approved', hoursAgo: 90, reviewer: 'banker-daniel' },
    { issuerId: 'capital-one', body: 'Capital One is available Monday between 2 PM and 5 PM for ABS East 2026.', status: 'Approved', hoursAgo: 80, reviewer: 'banker-priya' },
    { issuerId: 'rocket', body: 'Rocket Mortgage is available Wednesday between 9 AM and 12 PM for ABS East 2026.', status: 'Approved', hoursAgo: 70, reviewer: 'banker-michael' },
    { issuerId: 'newrez', body: 'NewRez is available Tuesday between 10 AM and 3 PM for ABS East 2026.', status: 'Approved', hoursAgo: 60, reviewer: 'banker-lauren' },
    { issuerId: 'onemain', body: 'OneMain Financial is available Monday afternoon for ABS East 2026, roughly after lunch.', status: 'Approved', edited: true, hoursAgo: 75, reviewer: 'banker-alex', note: 'Set 1–5 PM after calling the issuer' },
    { issuerId: 'penny', body: 'PennyMac can do Tuesday late morning at ABS East 2026.', status: 'Approved', edited: true, hoursAgo: 54, reviewer: 'banker-david', note: 'Confirmed 10:30–12:00 by phone' },
    { issuerId: 'bayview', body: 'Bayview is available Wednesday between 9 AM and 1 PM for ABS East 2026.', status: 'Approved', edited: true, hoursAgo: 48, reviewer: 'banker-alex', note: 'Corrected to 9–11 AM per the IR team' },
    { issuerId: 'discover', body: 'Discover would like to add a dinner on Tuesday at ABS East 2026.', status: 'Rejected', hoursAgo: 40, reviewer: 'banker-sarah', note: 'Dinners are booked outside the meeting schedule' },
    { issuerId: 'ally', body: 'Ally Financial would like to cancel all ABS East 2026 meetings.', status: 'Rejected', hoursAgo: 30, reviewer: 'banker-maya', note: 'Sent in error; Ally confirmed by phone' },
    { issuerId: 'ford', body: `Ford Credit is also available ${weekday(DAYS.M)} between 2 PM and 4 PM for ABS East 2026. Please add these times.`, status: 'Pending', hoursAgo: 26, reviewer: 'banker-sarah' },
    { issuerId: 'gmf', body: `GM Financial can also meet investors ${weekday(DAYS.M)} between 4 PM and 5 PM at ABS East 2026.`, status: 'Pending', hoursAgo: 7, reviewer: 'banker-daniel' },
  ];
  for (const [k, h] of history.entries()) {
    const issuer = issuers.find((i) => i.id === h.issuerId)!;
    const subject = `ABS East 2026 — ${issuer.name} availability`;
    const { asks } = mockExtractAsks(h.body, subject, { conferences, issuers, investors }, { conferenceId: 'abs-east', issuerId: h.issuerId });
    const ask = asks[0];
    const received = ago(h.hoursAgo);
    const reviewed = new Date(+received + (1 + (k % 4)) * 3600000);
    void newEmailContent;
    const mail = await db.email.create({
      data: {
        messageId: `demo-history-${k}`,
        threadId: `demo-history-thread-${k}`,
        sender: issuer.contactEmail,
        to: [`${h.reviewer.replace('banker-', '')}@conferenceos.demo`],
        cc: [],
        subject,
        body: `${h.body}\n\n(Demo history record)`,
        newContent: h.body,
        receivedAt: received,
        conferenceId: 'abs-east',
        issuerId: h.issuerId,
        category: ask.category,
        status: h.status === 'Pending' ? 'Pending review' : h.status,
        senderStatus: 'verified',
        source: 'demo-history',
      },
    });
    const proposal = await db.proposal.create({
      data: {
        emailId: mail.id,
        askIndex: 0,
        summary: ask.summary,
        extraction: ask,
        status: h.status,
        reviewerId: h.status === 'Pending' ? null : h.reviewer,
        reviewNote: h.note || null,
        editedOnReview: Boolean(h.edited),
        reviewedAt: h.status === 'Pending' ? null : reviewed,
        createdAt: received,
      },
    });
    if (h.status === 'Pending')
      await db.action.create({
        data: { type: ask.category, title: `${issuer.name} · ${ask.summary}`, conferenceId: 'abs-east', issuerId: h.issuerId, emailId: mail.id, proposalId: proposal.id, assignedTo: issuer.ownerId, priority: 'Normal', recommendation: 'Review extracted availability and source evidence.', createdAt: received },
      });
    else
      await db.auditLog.create({
        data: { actorId: h.reviewer, action: `Ask ${h.status.toLowerCase()}`, entityType: 'Proposal', entityId: proposal.id, issuerId: h.issuerId, emailId: mail.id, note: h.note || null, after: { demoHistory: true, edited: Boolean(h.edited) }, createdAt: reviewed },
      });
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
