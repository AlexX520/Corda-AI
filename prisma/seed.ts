import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { mockExtractAsks, newEmailContent } from '../src/lib/extraction';
import { conferenceTime } from '../src/lib/scheduling';
const db = new PrismaClient();
/**
 * Demo dates follow the calendar: ABS East runs Monday–Wednesday of this week (next week from
 * Thursday on), so "today", "My day" and active-event logic show live data. The second
 * conference is two weeks later.
 */
function demoDates(now = new Date()) {
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const dow = now.getUTCDay(); // 0 Sun … 6 Sat
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() + (dow >= 1 && dow <= 3 ? 1 - dow : (8 - dow) % 7 || 7));
  const day = (n: number) => {
    const d = new Date(monday);
    d.setUTCDate(d.getUTCDate() + n);
    return ymd(d);
  };
  return { abs: [day(0), day(1), day(2)], sf: [day(14), day(15), day(16)], ndr: day(8) };
}
const DATES = process.env.DEMO_FIXED_DATES === 'true'
  ? { abs: ['2026-10-19', '2026-10-20', '2026-10-21'], sf: ['2026-11-02', '2026-11-03', '2026-11-04'], ndr: '2026-10-27' }
  : demoDates();
/** Seed rows were written with day numbers 19/20/21; map them onto the demo week. */
const absDay = (d: string) => DATES.abs[Number(d) - 19];
async function main() {
  const users = [
    {
      id: 'banker-alex',
      name: 'Alex Morgan',
      email: 'alex.morgan@conferenceos.demo',
      role: 'BANKER',
    },
    {
      id: 'banker-sarah',
      name: 'Sarah Chen',
      email: 'sarah.chen@conferenceos.demo',
      role: 'BANKER',
    },
    { id: 'banker-maya', name: 'Maya Patel', email: 'maya.patel@conferenceos.demo', role: 'BANKER' },
    { id: 'banker-daniel', name: 'Daniel Kim', email: 'daniel.kim@conferenceos.demo', role: 'BANKER' },
    { id: 'banker-priya', name: 'Priya Shah', email: 'priya.shah@conferenceos.demo', role: 'BANKER' },
    { id: 'banker-michael', name: 'Michael Torres', email: 'michael.torres@conferenceos.demo', role: 'BANKER' },
    { id: 'banker-lauren', name: 'Lauren Brooks', email: 'lauren.brooks@conferenceos.demo', role: 'BANKER' },
    { id: 'banker-david', name: 'David Lin', email: 'david.lin@conferenceos.demo', role: 'BANKER' },
    {
      id: 'sales-james',
      name: 'James Wilson',
      email: 'james.wilson@conferenceos.demo',
      role: 'SALES',
    },
    { id: 'sales-emma', name: 'Emma Davis', email: 'emma.davis@conferenceos.demo', role: 'SALES' },
    { id: 'manager-morgan', name: 'Morgan Lee', email: 'morgan.lee@conferenceos.demo', role: 'MANAGER' },
  ];
  for (const u of users) await db.user.upsert({ where: { id: u.id }, create: u, update: {} });
  const conferences = [
    {
      id: 'abs-east',
      name: 'ABS East 2026',
      location: 'Fontainebleau · Miami Beach',
      timezone: 'America/New_York',
      startDate: DATES.abs[0],
      endDate: DATES.abs[2],
      slotMinutes: 30,
      roomBufferMinutes: 0,
      preferenceDeadline: new Date(`${DATES.abs[0]}T00:00:00Z`),
      preferenceWeight: 100,
      workloadWeight: 12,
      backToBackWeight: 5,
    },
    {
      id: 'sf-vegas',
      name: 'Structured Finance Summit',
      location: 'Las Vegas, Nevada',
      timezone: 'America/Los_Angeles',
      startDate: DATES.sf[0],
      endDate: DATES.sf[2],
      slotMinutes: 30,
    },
    {
      id: 'discover-ndr',
      name: 'Discover NDR — Boston',
      location: 'Boston, MA',
      timezone: 'America/New_York',
      startDate: DATES.ndr,
      endDate: DATES.ndr,
      slotMinutes: 60,
      type: 'NDR',
    },
  ];
  for (const c of conferences)
    await db.conference.upsert({ where: { id: c.id }, create: c, update: {} });
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
  const investors = [
    { id: 'pimco', name: 'PIMCO', contactEmail: 'meetings@pimco.example' },
    { id: 'blackrock', name: 'BlackRock', contactEmail: 'meetings@blackrock.example' },
    {
      id: 'wellington',
      name: 'Wellington Management',
      contactEmail: 'meetings@wellington.example',
    },
    { id: 'fidelity', name: 'Fidelity', contactEmail: 'meetings@fidelity.example' },
    { id: 'apollo', name: 'Apollo', contactEmail: 'meetings@apollo.example' },
    { id: 'ford-investor', name: 'Ford Credit', contactEmail: 'investments@fordcredit.example' },
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
  const jamesAccounts = ['pimco', 'blackrock', 'wellington', 'fidelity', 'apollo'];
  for (const i of investors) {
    const coverageSalesId = jamesAccounts.includes(i.id) ? 'sales-james' : 'sales-emma';
    await db.investor.upsert({ where: { id: i.id }, create: { ...i, coverageSalesId }, update: {} });
  }
  const time = (day: string, hour: string) => conferenceTime(absDay(day), hour, 'America/New_York');
  for (const [index, i] of issuers.entries())
    for (const day of ['19', '20', '21']) {
      const id = `seed-av-${i.id}-${day}`;
      await db.availability.upsert({
        where: { id },
        create: {
          id,
          conferenceId: 'abs-east',
          issuerId: i.id,
          start: time(day, index % 2 ? '09:00' : '10:00'),
          end: time(day, '17:00'),
          approvedBy: i.ownerId || 'banker-alex',
        },
        update: {},
      });
    }
  const meetings = [
    ['bayview', 'pimco', '19', '15:00', '15:30', 'Ocean Tower · 201'],
    ['ford', 'blackrock', '19', '10:00', '10:30', 'Ocean Tower · 203'],
    ['santander', 'wellington', '19', '11:00', '11:30', 'Tresor · 102'],
    ['athene', 'apollo', '19', '14:00', '14:30', 'Ocean Tower · 204'],
    ['onemain', 'apollo', '20', '10:00', '10:30', 'Tresor · 103'],
    ['bayview', 'wellington', '20', '11:00', '11:30', 'Ocean Tower · 201'],
    ['ford', 'pimco', '20', '13:00', '13:30', 'Ocean Tower · 203'],
    ['ally', 'metlife', '19', '10:00', '10:30', ''],
    ['capital-one', 'prudential', '19', '10:00', '10:30', ''],
    ['gmf', 'pgim', '19', '10:00', '10:30', ''],
    ['newrez', 'vanguard', '19', '10:00', '10:30', ''],
    ['rocket', 'ares', '19', '10:00', '10:30', ''],
    ['discover', 'kkr', '19', '10:00', '10:30', ''],
    ['penny', 'nuveen', '19', '11:30', '12:00', ''],
    ['ally', 'trowe', '19', '13:00', '13:30', ''],
    ['capital-one', 'invesco', '19', '13:30', '14:00', ''],
    ['gmf', 'fidelity', '19', '15:00', '15:30', ''],
    ['newrez', 'blackrock', '20', '09:30', '10:00', ''],
    ['rocket', 'pimco', '20', '10:00', '10:30', ''],
    ['discover', 'wellington', '20', '10:30', '11:00', ''],
    ['penny', 'metlife', '20', '11:00', '11:30', ''],
    ['santander', 'prudential', '20', '13:00', '13:30', ''],
    ['athene', 'pgim', '20', '14:00', '14:30', ''],
    ['onemain', 'vanguard', '21', '09:30', '10:00', ''],
    ['bayview', 'ares', '21', '10:30', '11:00', ''],
  ];
  for (const [idx, [issuerId, investorId, day, start, end, location]] of meetings.entries()) {
    const id = `seed-meeting-${idx}`;
    await db.meeting.upsert({
      where: { id },
      create: {
        id,
        conferenceId: 'abs-east',
        issuerId,
        investorId,
        start: time(day, start),
        end: time(day, end),
        location,
        bankerIds: [],
        expectedAttendees: idx % 5 === 0 ? 8 : 4 + (idx % 3),
        requiresCube: true,
        approvedBy: 'banker-alex',
        approvedRecipients: [],
      },
      update: {},
    });
  }
  const bankerIds = users.filter((u) => u.role === 'BANKER').map((u) => u.id);
  for (const bankerId of bankerIds) {
    for (const day of ['19', '20', '21']) {
      await db.bankerAvailability.upsert({
        where: { id: `seed-banker-av-${bankerId}-${day}` },
        create: {
          id: `seed-banker-av-${bankerId}-${day}`,
          conferenceId: 'abs-east',
          bankerId,
          start: time(day, '09:00'),
          end: time(day, '17:00'),
          status: 'Available',
        },
        update: {},
      });
    }
  }
  await db.bankerAvailability.upsert({
    where: { id: 'seed-banker-block-alex' },
    create: {
      id: 'seed-banker-block-alex', conferenceId: 'abs-east', bankerId: 'banker-alex',
      start: time('20', '12:00'), end: time('20', '13:00'), status: 'Unavailable',
    }, update: {},
  });
  for (const [issuerIndex, issuer] of issuers.entries()) {
    const supporting = [bankerIds[issuerIndex % bankerIds.length], bankerIds[(issuerIndex + 2) % bankerIds.length], bankerIds[(issuerIndex + 4) % bankerIds.length]];
    for (const [index, bankerId] of [...new Set([issuer.ownerId, ...supporting].filter(Boolean))].entries()) {
      await db.issuerCoverageAuthorization.upsert({
        where: { conferenceId_bankerId_issuerId: { conferenceId: 'abs-east', issuerId: issuer.id, bankerId: bankerId! } },
        create: {
          conferenceId: 'abs-east', issuerId: issuer.id, bankerId: bankerId!,
          qualification: index === 0 ? 'Primary' : 'Support', isActive: true,
        },
        update: {},
      });
    }
  }
  for (const [index, bankerId] of bankerIds.entries()) {
    for (const issuer of issuers.filter((_, issuerIndex) => issuerIndex % bankerIds.length === index % bankerIds.length).slice(0, 2)) {
      await db.bankerPreference.upsert({
        where: { id: `seed-pref-${bankerId}-${issuer.id}` },
        create: {
          id: `seed-pref-${bankerId}-${issuer.id}`, conferenceId: 'abs-east', bankerId, issuerId: issuer.id,
          preferenceLevel: index % 3 === 0 ? 'High Priority' : 'Medium Priority', preferenceWeight: index % 3 === 0 ? 80 : 45,
          submissionStatus: 'Submitted',
        }, update: {},
      });
    }
  }
  for (const [bankerId, meetingId] of [['banker-maya', 'seed-meeting-7'], ['banker-maya', 'seed-meeting-8']]) {
    const meeting = meetings[Number(meetingId.split('-').at(-1))];
    await db.bankerPreference.upsert({
      where: { id: `seed-must-${meetingId}` },
      create: {
        id: `seed-must-${meetingId}`, conferenceId: 'abs-east', bankerId, issuerId: meeting[0], meetingId,
        preferenceLevel: 'Must Attend', preferenceWeight: 120, isMandatory: true,
        submissionStatus: 'Submitted',
      }, update: {},
    });
  }
  const cubes = [
    ['cube-1', 'Meeting Cube 1', 4, 'Ocean Tower · Level 2'],
    ['cube-2', 'Meeting Cube 2', 6, 'Ocean Tower · Level 2'],
    ['cube-3', 'Meeting Cube 3', 6, 'Ocean Tower · Level 2'],
    ['cube-4', 'Meeting Cube 4', 8, 'Tresor · Level 1'],
    ['cube-5', 'Meeting Cube 5', 10, 'Tresor · Level 1'],
  ];
  for (const [cubeId, name, capacity, location] of cubes) {
    await db.meetingCube.upsert({
      where: { id: cubeId as string },
      create: { id: cubeId as string, conferenceId: 'abs-east', name: name as string, capacity: capacity as number, location: location as string },
      update: {},
    });
    for (const day of ['19', '20', '21']) {
      await db.cubeAvailability.upsert({
        where: { id: `seed-cube-av-${cubeId}-${day}` },
        create: { id: `seed-cube-av-${cubeId}-${day}`, cubeId: cubeId as string, start: time(day, '09:00'), end: time(day, '17:00'), status: 'Available' },
        update: {},
      });
    }
  }
  for (let idx = 0; idx < meetings.length; idx++) {
    await db.meetingCoverageRequirement.upsert({
      where: { meetingId: `seed-meeting-${idx}` },
      create: { meetingId: `seed-meeting-${idx}`, requiredBankerCount: idx % 8 === 0 ? 3 : 2, requiredPrimaryCount: 1 },
      update: {},
    });
  }
  await db.meetingCoverageAssignment.upsert({
    where: { meetingId_bankerId: { meetingId: 'seed-meeting-0', bankerId: 'banker-alex' } },
    create: { meetingId: 'seed-meeting-0', bankerId: 'banker-alex', coverageRole: 'Primary', assignmentStatus: 'Approved', isLocked: true, assignedBy: 'banker-alex' },
    update: {},
  });
  await db.meetingCubeAssignment.upsert({
    where: { meetingId: 'seed-meeting-0' },
    create: { meetingId: 'seed-meeting-0', cubeId: 'cube-5', assignmentStatus: 'Approved', isLocked: true, assignedBy: 'banker-alex' },
    update: {},
  });
  await db.availability.upsert({
    where: { id: 'seed-hold' },
    create: {
      id: 'seed-hold',
      conferenceId: 'abs-east',
      issuerId: 'bayview',
      start: time('19', '13:00'),
      end: time('19', '13:30'),
      kind: 'Hold',
      approvedBy: 'banker-alex',
    },
    update: {},
  });
  const requests = [
    ['bayview', 'ford-investor', '19', '15:00', 'Alternative Slots Available', 'High'],
    ['santander', 'fidelity', '19', '14:00', 'Potential Match', 'Normal'],
    ['penny', 'apollo', '20', '10:00', 'Awaiting Issuer Availability', 'High'],
    ['athene', 'blackrock', '20', '11:00', 'Potential Match', 'Normal'],
  ];
  for (const [idx, [issuerId, investorId, day, start, status, priority]] of requests.entries()) {
    const id = `seed-request-${idx}`,
      s = time(day, start),
      issuer = issuers.find((i) => i.id === issuerId)!;
    await db.meetingRequest.upsert({
      where: { id },
      create: {
        id,
        conferenceId: 'abs-east',
        issuerId,
        investorId,
        salespersonId: 'sales-james',
        bankerId: issuer.ownerId,
        start: s,
        end: new Date(+s + 30 * 60000),
        duration: 30,
        alternativeDates: [],
        notes:
          idx === 0
            ? 'Portfolio team would like to discuss the residential credit pipeline.'
            : 'One-on-one meeting requested by the investment team.',
        priority,
        status,
      },
      update: {},
    });
    await db.action.upsert({
      where: { id: `seed-action-request-${idx}` },
      create: {
        id: `seed-action-request-${idx}`,
        type: 'Meeting request',
        title: `${investors.find((i) => i.id === investorId)!.name} requested ${issuer.name}`,
        conferenceId: 'abs-east',
        issuerId,
        investorId,
        requestId: id,
        assignedTo: issuer.ownerId,
        priority,
        recommendation:
          idx === 0
            ? 'Requested time overlaps a confirmed meeting. Review alternatives.'
            : 'Check availability and obtain issuer consent.',
      },
      update: {},
    });
  }
  const samples = [
    {
      id: 'bayview-update',
      issuerId: 'bayview',
      subject: 'ABS East — updated availability',
      body: 'Hi Alex,\n\nBayview is available Monday between 3 PM and 5 PM for ABS East 2026. However, we already have a meeting scheduled between 3 PM and 3:30 PM. We can also accommodate meetings Tuesday morning.\n\nBest,\nRachel\n\nOn Friday, Alex wrote:\n> Could you confirm your availability?',
    },
    {
      id: 'ford-reschedule',
      issuerId: 'ford',
      subject: 'ABS East 2026 — reschedule BlackRock meeting',
      body: 'Hi Sarah,\n\nFord Credit would like to reschedule our BlackRock meeting. Could we move the meeting to Monday between 11 AM and 11:30 AM for ABS East 2026?\n\nThank you,\nDavid',
    },
    {
      id: 'santander-confirm',
      issuerId: 'santander',
      subject: 'ABS East 2026 — Fidelity confirmation',
      body: 'Hi Alex,\n\nSantander confirms the Fidelity meeting for Monday between 2 PM and 2:30 PM at ABS East 2026. We look forward to meeting the team.\n\nBest,\nMaria',
    },
    {
      id: 'athene-availability',
      issuerId: 'athene',
      subject: 'ABS East 2026 — Tuesday availability',
      body: 'Hello Sarah,\n\nAthene is available Tuesday between 9 AM and 12 PM for ABS East 2026. Please add this availability to our schedule.\n\nRegards,\nTom',
    },
    {
      id: 'onemain-cancel',
      issuerId: 'onemain',
      subject: 'ABS East 2026 — Apollo meeting',
      body: 'Hi Alex,\n\nPlease cancel the OneMain Financial meeting with Apollo on Tuesday at ABS East 2026. Our CFO has a travel conflict.\n\nThanks,\nEmily',
    },
  ];
  for (const s of samples) {
    if (await db.email.findUnique({ where: { messageId: s.id } })) continue;
    const { asks } = mockExtractAsks(
      s.body,
      s.subject,
      { conferences, issuers, investors },
      { conferenceId: 'abs-east', issuerId: s.issuerId },
    );
    const issuer = issuers.find((i) => i.id === s.issuerId)!;
    const mail = await db.email.create({
      data: {
        messageId: s.id,
        threadId: `thread-${s.id}`,
        sender: issuer.contactEmail,
        to: ['alex.morgan@conferenceos.demo'],
        cc: [],
        subject: s.subject,
        body: s.body,
        newContent: newEmailContent(s.body),
        conferenceId: asks[0].conferenceId,
        issuerId: asks[0].issuerId,
        investorId: asks.length === 1 ? asks[0].investorId : null,
        category: asks.length === 1 ? asks[0].category : 'Multiple asks',
        senderStatus: 'verified',
      },
    });
    for (const [askIndex, e] of asks.entries()) {
      const proposal = await db.proposal.create({
        data: { emailId: mail.id, askIndex, summary: e.summary, extraction: e },
      });
      await db.action.create({
        data: {
          type: e.category,
          title: `${issuer.name} · ${e.summary}`,
          conferenceId: 'abs-east',
          issuerId: s.issuerId,
          investorId: e.investorId,
          emailId: mail.id,
          proposalId: proposal.id,
          assignedTo: issuer.ownerId,
          priority: e.uncertainties.length ? 'High' : 'Normal',
          recommendation: e.uncertainties[0] || 'Review extracted availability and source evidence.',
        },
      });
    }
  }
  await db.auditLog.upsert({
    where: { id: 'seed-audit' },
    create: {
      id: 'seed-audit',
      actorId: 'banker-alex',
      action: 'Synthetic conference initialized',
      entityType: 'Conference',
      entityId: 'abs-east',
      after: { synthetic: true },
    },
    update: {},
  });
  await seedNdr();
  await seedDemoHistory(issuers, investors, conferences);
  console.log(
    'Seed complete. 3 events (2 conferences, 1 NDR), 1 manager, 12 issuers, 15 investors, 8 bankers, 25 meetings and 5 cubes. Existing records preserved.',
  );
}
/** Discover NDR — Boston: one day of investor meetings with the issuer's management. */
async function seedNdr() {
  const at = (hhmm: string) => conferenceTime(DATES.ndr, hhmm, 'America/New_York');
  await db.availability.upsert({
    where: { id: 'ndr-availability' },
    create: { id: 'ndr-availability', conferenceId: 'discover-ndr', issuerId: 'discover', start: at('08:30'), end: at('17:00'), approvedBy: 'banker-sarah' },
    update: {},
  });
  const rows: [string, string, string][] = [['pimco', '09:00', 'Hotel Commonwealth · Suite 4'], ['blackrock', '10:30', 'BlackRock Boston office'], ['wellington', '13:00', 'Wellington · 280 Congress St']];
  for (const [i, [investorId, start, location]] of rows.entries()) {
    const requestId = `ndr-request-${i}`;
    const created = new Date(Date.now() - (60 - i * 12) * 3600000);
    await db.meetingRequest.upsert({
      where: { id: requestId },
      create: { id: requestId, conferenceId: 'discover-ndr', issuerId: 'discover', investorId, salespersonId: investorId === 'pimco' || investorId === 'blackrock' || investorId === 'wellington' ? 'sales-james' : 'sales-emma', bankerId: 'banker-sarah', start: at(start), end: new Date(+at(start) + 60 * 60000), duration: 60, alternativeDates: [], notes: '[Demo history] NDR one-on-one', priority: 'Normal', status: 'Confirmed', createdAt: created },
      update: {},
    });
    await db.meeting.upsert({
      where: { id: `ndr-meeting-${i}` },
      create: { id: `ndr-meeting-${i}`, requestId, conferenceId: 'discover-ndr', issuerId: 'discover', investorId, start: at(start), end: new Date(+at(start) + 60 * 60000), location, bankerIds: ['banker-sarah'], approvedBy: 'banker-sarah', approvedRecipients: [], expectedAttendees: 3, requiresCube: false, createdAt: new Date(+created + (3 + i * 5) * 3600000) },
      update: {},
    });
  }
  await db.meetingRequest.upsert({
    where: { id: 'ndr-request-open' },
    create: { id: 'ndr-request-open', conferenceId: 'discover-ndr', issuerId: 'discover', investorId: 'kkr', salespersonId: 'sales-emma', bankerId: 'banker-sarah', start: at('15:00'), end: at('16:00'), duration: 60, alternativeDates: [], notes: '[Demo history] KKR would like the afternoon slot', priority: 'High', status: 'Potential Match', createdAt: new Date(Date.now() - 20 * 3600000) },
    update: {},
  });
}

/**
 * Demo history (clearly marked: emails have source "demo-history", requests say "[Demo history]"),
 * so the manager dashboard has real records to compute from: requests confirmed over the past
 * days, emails approved as read / edited / rejected, and a few that are still waiting.
 */
async function seedDemoHistory(
  issuers: { id: string; name: string; contactEmail: string; ownerId: string | null }[],
  investors: { id: string; name: string; contactEmail: string }[],
  conferences: { id: string; name: string; startDate: string; endDate: string; timezone: string }[],
) {
  if (await db.email.findFirst({ where: { source: 'demo-history' } })) return;
  const ago = (hours: number) => new Date(Date.now() - hours * 3600000);
  // 1. Past requests that became today's seeded meetings (time-to-confirm 2–30 hours).
  const linked = [0, 1, 2, 3, 4, 5, 6, 7, 9, 12, 14, 16];
  const delays = [2, 5, 26, 3, 8, 30, 4, 12, 6, 18, 2.5, 9];
  for (const [k, idx] of linked.entries()) {
    const m = await db.meeting.findUnique({ where: { id: `seed-meeting-${idx}` } });
    if (!m || m.requestId) continue;
    const created = ago(72 + k * 7);
    const requestId = `demo-history-request-${idx}`;
    const covered = ['pimco', 'blackrock', 'wellington', 'fidelity', 'apollo'].includes(m.investorId);
    await db.meetingRequest.create({
      data: { id: requestId, conferenceId: m.conferenceId, issuerId: m.issuerId, investorId: m.investorId, salespersonId: covered ? 'sales-james' : 'sales-emma', bankerId: issuers.find((i) => i.id === m.issuerId)?.ownerId || null, start: m.start, end: m.end, duration: 30, alternativeDates: [], notes: '[Demo history] Confirmed earlier this week', priority: 'Normal', status: 'Confirmed', createdAt: created },
    });
    await db.meeting.update({ where: { id: m.id }, data: { requestId, createdAt: new Date(+created + delays[k] * 3600000) } });
  }
  // 2. Issuer emails reviewed over the past days.
  const absStart = conferences[0].startDate;
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
    { issuerId: 'ford', body: 'Ford Credit is available Wednesday between 2 PM and 4 PM for ABS East 2026. Please add these times.', status: 'Pending', hoursAgo: 26, reviewer: 'banker-sarah' },
    { issuerId: 'gmf', body: 'GM Financial can also meet investors Monday between 4 PM and 5 PM at ABS East 2026.', status: 'Pending', hoursAgo: 7, reviewer: 'banker-daniel' },
  ];
  for (const [k, h] of history.entries()) {
    const issuer = issuers.find((i) => i.id === h.issuerId)!;
    const subject = `ABS East 2026 — ${issuer.name} availability`;
    const { asks } = mockExtractAsks(h.body, subject, { conferences, issuers, investors }, { conferenceId: 'abs-east', issuerId: h.issuerId });
    const ask = asks[0];
    const received = ago(h.hoursAgo);
    const reviewed = new Date(+received + (1 + (k % 4)) * 3600000);
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
  // 3. An open escalation a few hours old.
  const esc = await db.email.create({
    data: { messageId: 'demo-history-escalation', threadId: 'demo-history-escalation', sender: 'meetings@kkr.example', to: ['sarah.chen@conferenceos.demo'], cc: [], subject: 'Discover × KKR — third move this week', body: 'This is the third time this meeting has moved. If it moves again we will pass.\n\n(Demo history record)', newContent: 'This is the third time this meeting has moved. If it moves again we will pass.', receivedAt: ago(3), conferenceId: 'abs-east', investorId: 'kkr', issuerId: 'discover', category: 'Escalation / complaint', status: 'Pending review', senderStatus: 'verified', source: 'demo-history', escalation: true, escalationReasons: ['Threat to drop the meeting'] },
  });
  const escAsk = mockExtractAsks('This is the third time this meeting has moved. If it moves again we will pass.', esc.subject, { conferences, issuers, investors }, { conferenceId: 'abs-east' }).asks[0];
  const escProposal = await db.proposal.create({ data: { emailId: esc.id, askIndex: 0, summary: 'KKR: third move this week — will pass if it moves again', extraction: { ...escAsk, category: 'Escalation / complaint', operation: 'escalate', issuerId: 'discover', investorId: 'kkr' }, createdAt: ago(3) } });
  await db.action.create({ data: { type: 'Escalation / complaint', title: 'KKR · third move this week, will pass if moved again', conferenceId: 'abs-east', issuerId: 'discover', investorId: 'kkr', emailId: esc.id, proposalId: escProposal.id, assignedTo: 'banker-sarah', priority: 'Urgent', recommendation: 'Call KKR; do not move Discover × KKR again without their agreement.', createdAt: ago(3) } });
  void absStart;
}
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
