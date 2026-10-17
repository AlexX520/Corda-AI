import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
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
    if (!['master', 'issuer', 'investor', 'meeting', 'banker', 'cube'].includes(scope))
      throw new Error('Invalid planner scope.');
    if (['banker', 'cube'].includes(scope) && user.role !== 'BANKER')
      throw new Error('This internal schedule requires Banker access.');
    if (scope !== 'master' && !id) throw new Error('Select a planner audience.');
    const c = await db.conference.findUniqueOrThrow({ where: { id: conferenceId } });
    const meetingRows = await db.meeting.findMany({
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
    const [coverage, roomAssignments, cubes, people, issuers, investors] = await Promise.all([
      db.meetingCoverageAssignment.findMany({ where: { meetingId: { in: meetingRows.map((m) => m.id) } } }),
      db.meetingCubeAssignment.findMany({ where: { meetingId: { in: meetingRows.map((m) => m.id) } } }),
      db.meetingCube.findMany({ where: { conferenceId } }),
      db.user.findMany({ where: { role: 'BANKER' } }),
      db.issuer.findMany(),
      db.investor.findMany(),
    ]);
    const meetings = meetingRows.filter((m) => scope === 'banker'
      ? coverage.some((a) => a.meetingId === m.id && a.bankerId === id)
      : scope === 'cube'
        ? roomAssignments.some((a) => a.meetingId === m.id && a.cubeId === id)
        : true);
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
        'PRODID:-//Corda AI//Local MVP//EN',
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
    if (q.get('format') === 'pdf') {
      const doc = new PDFDocument({ size: 'A4', margin: 34, layout: 'landscape' });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.fontSize(18).fillColor('#174f43').text(`${c.name} — Master Schedule`);
      doc.moveDown(0.25).fontSize(8).fillColor('#68756d').text(`${c.timezone} · ${scope.toUpperCase()} · ${authorized.length} confirmed meetings`);
      doc.moveDown(0.8);
      const columns = [34, 100, 190, 285, 370, 485, 610, 700];
      const header = () => {
        doc.fontSize(7).fillColor('#174f43').text('DATE / TIME', columns[0], doc.y)
          .text('ISSUER', columns[1], doc.y - 8).text('INVESTOR', columns[2], doc.y - 8)
          .text('PRIMARY', columns[3], doc.y - 8).text('ADDITIONAL COVERAGE', columns[4], doc.y - 8)
          .text('MEETING CUBE', columns[5], doc.y - 8).text('STATUS', columns[6], doc.y - 8);
        doc.moveDown(0.8).strokeColor('#dfe5dd').moveTo(34, doc.y).lineTo(760, doc.y).stroke(); doc.moveDown(0.4);
      };
      header();
      for (const m of authorized) {
        if (doc.y > 525) { doc.addPage(); header(); }
        const rowY = doc.y;
        const cov = coverage.filter((a) => a.meetingId === m.id);
        const room = roomAssignments.find((a) => a.meetingId === m.id);
        const cube = cubes.find((x) => x.id === room?.cubeId);
        const person = (bankerId: string) => people.find((p) => p.id === bankerId)?.name || bankerId;
        const primary = cov.filter((a) => a.coverageRole === 'Primary').map((a) => person(a.bankerId)).join(', ') || 'UNASSIGNED';
        const support = cov.filter((a) => a.coverageRole !== 'Primary').map((a) => person(a.bankerId)).join(', ') || '—';
        doc.fontSize(7).fillColor('#33453b')
          .text(formatInTimeZone(m.start, c.timezone, 'MMM d\nHH:mm'), columns[0], rowY, {width: 60})
          .text(issuers.find((x) => x.id === m.issuerId)?.name || '', columns[1], rowY, {width: 84})
          .text(investors.find((x) => x.id === m.investorId)?.name || '', columns[2], rowY, {width: 90})
          .text(primary, columns[3], rowY, {width: 80}).text(support, columns[4], rowY, {width: 110})
          .text(cube?.name || 'UNASSIGNED', columns[5], rowY, {width: 115})
          .fillColor(cov.length >= 2 && (!m.requiresCube || cube) ? '#32725b' : '#a16b27')
          .text(cov.length >= 2 && (!m.requiresCube || cube) ? 'READY' : 'NEEDS REVIEW', columns[6], rowY, {width: 90});
        doc.y = rowY + 28; doc.strokeColor('#edf0ec').moveTo(34, doc.y).lineTo(760, doc.y).stroke(); doc.moveDown(0.35);
      }
      doc.end();
      const pdf = await new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
      return new Response(new Uint8Array(pdf), { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="conferenceos-${scope}-schedule.pdf"`, 'Cache-Control': 'no-store' } });
    }
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Corda AI';
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
      { header: 'Primary Banker', key: 'primary', width: 25 },
      { header: 'Additional Coverage', key: 'additional', width: 35 },
      { header: 'Meeting Cube', key: 'cube', width: 24 },
      { header: 'Status', key: 'status', width: 18 },
      { header: 'Approved recipients', key: 'recipients', width: 50 },
    ];
    for (const m of authorized) {
      const i = issuers.find((x) => x.id === m.issuerId)!, v = investors.find((x) => x.id === m.investorId)!;
      const cov = coverage.filter((a) => a.meetingId === m.id), room = roomAssignments.find((a) => a.meetingId === m.id), cube = cubes.find((x) => x.id === room?.cubeId);
      const person = (bankerId: string) => people.find((p) => p.id === bankerId)?.name || bankerId;
      sheet.addRow({
        conference: safe(c.name),
        id: m.id,
        issuer: safe(i.name),
        investor: safe(v.name),
        date: formatInTimeZone(m.start, c.timezone, 'yyyy-MM-dd'),
        start: formatInTimeZone(m.start, c.timezone, 'HH:mm'),
        end: formatInTimeZone(m.end, c.timezone, 'HH:mm'),
        timezone: c.timezone,
        primary: cov.filter((a) => a.coverageRole === 'Primary').map((a) => safe(person(a.bankerId))).join(', ') || 'UNASSIGNED',
        additional: cov.filter((a) => a.coverageRole !== 'Primary').map((a) => safe(person(a.bankerId))).join(', '),
        cube: cube?.name || 'UNASSIGNED',
        status: cov.length >= 2 && (!m.requiresCube || cube) ? m.status : 'Needs resources',
        recipients: recipient ? recipient : m.approvedRecipients.join(', '),
      });
    }
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF123D35' } };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: 'A1', to: 'M1' };
    sheet.eachRow((row, rowNumber) => { if (rowNumber > 1 && row.getCell('status').value === 'Needs resources') row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF1D6' } }; });
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
