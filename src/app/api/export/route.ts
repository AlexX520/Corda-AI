import ExcelJS from 'exceljs';
import { formatInTimeZone } from 'date-fns-tz';
import { currentUser, errorResponse } from '@/lib/auth';
import { db } from '@/lib/db';
export const dynamic = 'force-dynamic';
const safe = (s: string) => (/^[=+@-]/.test(s) ? `'${s}` : s);
const icsText = (s: string) =>
  s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
export async function GET(req: Request) {
  try {
    const user = await currentUser(),
      q = new URL(req.url).searchParams;
    const scope = q.get('scope') || 'master',
      id = q.get('id'),
      conferenceId = q.get('conferenceId') || 'abs-east';
    if (!['master', 'issuer', 'investor', 'meeting'].includes(scope))
      throw new Error('Invalid planner scope.');
    if (scope !== 'master' && !id) throw new Error('Select a planner audience.');
    const c = await db.conference.findUniqueOrThrow({ where: { id: conferenceId } });
    const meetings = await db.meeting.findMany({
      where: {
        conferenceId,
        status: 'Confirmed',
        ...(scope === 'issuer'
          ? { issuerId: id! }
          : scope === 'investor'
            ? { investorId: id! }
            : scope === 'meeting'
              ? { id: id! }
              : {}),
        ...(user.role === 'SALES' ? { request: { salespersonId: user.id } } : {}),
      },
      orderBy: { start: 'asc' },
    });
    const recipient = q.get('recipient');
    if (recipient && scope === 'master')
      throw new Error('Master planners are internal only. Select a recipient-specific scope.');
    const authorized = recipient
      ? meetings.filter((m) => m.approvedRecipients.includes(recipient))
      : meetings;
    if (q.get('format') === 'ics') {
      if (scope !== 'meeting' || authorized.length !== 1)
        throw new Error('Select one authorized confirmed meeting.');
      const m = authorized[0],
        issuer = await db.issuer.findUniqueOrThrow({ where: { id: m.issuerId } }),
        investor = await db.investor.findUniqueOrThrow({ where: { id: m.investorId } });
      const utc = (d: Date) => formatInTimeZone(d, 'UTC', "yyyyMMdd'T'HHmmss'Z'");
      const text = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//ConferenceOS//Local MVP//EN',
        'BEGIN:VEVENT',
        `UID:${m.id}@conferenceos.local`,
        `DTSTAMP:${utc(m.updatedAt)}`,
        `DTSTART:${utc(m.start)}`,
        `DTEND:${utc(m.end)}`,
        `SUMMARY:${icsText(`${issuer.name} × ${investor.name} | ${c.name}`)}`,
        `LOCATION:${icsText(m.location)}`,
        `DESCRIPTION:${icsText(`Conference timezone: ${c.timezone}`)}`,
        'STATUS:CONFIRMED',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n');
      return new Response(text, {
        headers: {
          'Content-Type': 'text/calendar',
          'Content-Disposition': 'attachment; filename="meeting.ics"',
          'Cache-Control': 'no-store',
        },
      });
    }
    const wb = new ExcelJS.Workbook();
    wb.creator = 'ConferenceOS';
    const sheet = wb.addWorksheet('Conference Planner');
    sheet.columns = [
      { header: 'Conference', key: 'conference', width: 25 },
      { header: 'Meeting ID', key: 'id', width: 28 },
      { header: 'Issuer', key: 'issuer', width: 25 },
      { header: 'Investor', key: 'investor', width: 25 },
      { header: 'Date', key: 'date', width: 15 },
      { header: 'Start', key: 'start', width: 15 },
      { header: 'End', key: 'end', width: 15 },
      { header: 'Timezone', key: 'timezone', width: 25 },
      { header: 'Location', key: 'location', width: 25 },
      { header: 'Bankers', key: 'bankers', width: 25 },
      { header: 'Status', key: 'status', width: 18 },
      { header: 'Approved recipients', key: 'recipients', width: 50 },
    ];
    for (const m of authorized) {
      const i = await db.issuer.findUniqueOrThrow({ where: { id: m.issuerId } }),
        v = await db.investor.findUniqueOrThrow({ where: { id: m.investorId } }),
        bankers = await db.user.findMany({ where: { id: { in: m.bankerIds } } });
      sheet.addRow({
        conference: safe(c.name),
        id: m.id,
        issuer: safe(i.name),
        investor: safe(v.name),
        date: formatInTimeZone(m.start, c.timezone, 'yyyy-MM-dd'),
        start: formatInTimeZone(m.start, c.timezone, 'HH:mm'),
        end: formatInTimeZone(m.end, c.timezone, 'HH:mm'),
        timezone: c.timezone,
        location: safe(m.location),
        bankers: bankers.map((b) => safe(b.name)).join(', '),
        status: m.status,
        recipients: recipient ? recipient : m.approvedRecipients.join(', '),
      });
    }
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF123D35' } };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: 'A1', to: 'L1' };
    const info = wb.addWorksheet('Read me');
    info.addRow(['Audience', recipient || 'Internal authenticated user']);
    info.addRow(['Scope', scope]);
    info.addRow(['Timezone', c.timezone]);
    info.addRow([
      'Note',
      'Only confirmed meetings are included. Excel is an export artifact; the database is the source of truth.',
    ]);
    const buffer = await wb.xlsx.writeBuffer();
    return new Response(new Uint8Array(buffer as ArrayBuffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="conferenceos-${scope}-planner.xlsx"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
