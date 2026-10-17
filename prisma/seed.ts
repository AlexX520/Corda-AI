import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { mockExtract, newEmailContent } from '../src/lib/extraction';
import { conferenceTime } from '../src/lib/scheduling';
const db = new PrismaClient();
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
    {
      id: 'sales-james',
      name: 'James Wilson',
      email: 'james.wilson@conferenceos.demo',
      role: 'SALES',
    },
    { id: 'sales-emma', name: 'Emma Davis', email: 'emma.davis@conferenceos.demo', role: 'SALES' },
  ];
  for (const u of users) await db.user.upsert({ where: { id: u.id }, create: u, update: {} });
  const conferences = [
    {
      id: 'abs-east',
      name: 'ABS East 2026',
      location: 'Fontainebleau · Miami Beach',
      timezone: 'America/New_York',
      startDate: '2026-10-19',
      endDate: '2026-10-21',
      slotMinutes: 30,
    },
    {
      id: 'sf-vegas',
      name: 'Structured Finance Summit',
      location: 'Las Vegas, Nevada',
      timezone: 'America/Los_Angeles',
      startDate: '2026-11-02',
      endDate: '2026-11-04',
      slotMinutes: 30,
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
      ownerId: null,
    },
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
  ];
  for (const i of investors)
    await db.investor.upsert({ where: { id: i.id }, create: i, update: {} });
  const time = (day: string, hour: string) =>
    conferenceTime(`2026-10-${day}`, hour, 'America/New_York');
  for (const [index, i] of issuers.slice(0, 5).entries())
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
          approvedBy: i.ownerId!,
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
        bankerIds: [issuers.find((i) => i.id === issuerId)!.ownerId!],
        approvedBy: 'banker-alex',
        approvedRecipients: [],
      },
      update: {},
    });
  }
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
    const e = mockExtract(
      s.body,
      s.subject,
      { conferences, issuers, investors },
      { conferenceId: 'abs-east', issuerId: s.issuerId },
    );
    const mail = await db.email.create({
      data: {
        messageId: s.id,
        threadId: `thread-${s.id}`,
        sender: issuers.find((i) => i.id === s.issuerId)!.contactEmail,
        to: ['alex.morgan@conferenceos.demo'],
        cc: [],
        subject: s.subject,
        body: s.body,
        newContent: newEmailContent(s.body),
        conferenceId: e.conferenceId,
        issuerId: e.issuerId,
        investorId: e.investorId,
        category: e.category,
        proposal: { create: { extraction: e } },
      },
    });
    await db.action.create({
      data: {
        type: e.category,
        title: `${issuers.find((i) => i.id === s.issuerId)!.name} · ${s.subject.split('—')[1]?.trim()}`,
        conferenceId: 'abs-east',
        issuerId: s.issuerId,
        investorId: e.investorId,
        emailId: mail.id,
        assignedTo: issuers.find((i) => i.id === s.issuerId)!.ownerId,
        priority: e.uncertainties.length ? 'High' : 'Normal',
        recommendation: e.uncertainties[0] || 'Review extracted availability and source evidence.',
      },
    });
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
  console.log(
    'Seed complete. 2 conferences, 6 issuers, 6 investors, 4 demo users. Existing records preserved.',
  );
}
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
