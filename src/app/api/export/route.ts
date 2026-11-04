import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { formatInTimeZone } from 'date-fns-tz';
import { currentUser, errorResponse } from '@/lib/auth';
import { db } from '@/lib/db';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const safe = (s: string) => (/^[=+@-]/.test(s) ? `'${s}` : s);
/** "Corda-ABS-East-2026-Ford-Credit" — readable, filesystem-safe. */
const slug = (s: string) => s.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
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
    const audienceName =
      scope === 'issuer'
        ? issuers.find((x) => x.id === id)?.name
        : scope === 'investor'
          ? investors.find((x) => x.id === id)?.name
          : scope === 'banker'
            ? people.find((x) => x.id === id)?.name
            : scope === 'cube'
              ? cubes.find((x) => x.id === id)?.name
              : scope === 'meeting'
                ? 'Meeting'
                : 'Master';
    const baseName = `Corda-${slug(c.name)}-${slug(audienceName || scope)}`;
    const title =
      scope === 'issuer'
        ? `${audienceName} — Investor meeting planner`
        : scope === 'investor'
          ? `${audienceName} — Meeting itinerary`
          : scope === 'banker'
            ? `${audienceName} — Coverage schedule`
            : scope === 'cube'
              ? `${audienceName} — Room schedule`
              : 'Master Schedule';
    // Issuer and investor planners go to clients: no internal staffing or status columns.
    const clientFacing = scope === 'issuer' || scope === 'investor';
    const recipient = q.get('recipient');
    if (recipient && scope === 'master')
      throw new Error('Master planners are internal only. Select a recipient-specific scope.');
    const authorized = recipient
      ? meetings.filter((m) => m.approvedRecipients.includes(recipient))
      : meetings;
    // "Changed since last sent": compare with the previous export of this planner to this audience.
    const track = q.get('format') !== 'ics';
    const previous = track
      ? await db.exportLog.findFirst({
          where: { conferenceId, scope, audienceId: id || null },
          orderBy: { createdAt: 'desc' },
        })
      : null;
    const since = (m: (typeof authorized)[number]) =>
      !previous
        ? ''
        : !previous.meetingIds.includes(m.id)
          ? 'New'
          : m.changedAt && m.changedAt > previous.createdAt
            ? 'Changed'
            : '';
    const removed = previous
      ? await db.meeting.findMany({
          where: { id: { in: previous.meetingIds.filter((x) => !authorized.some((m) => m.id === x)) } },
          orderBy: { start: 'asc' },
        })
      : [];
    const sinceNote = previous
      ? `Changes since the version sent ${formatInTimeZone(previous.createdAt, c.timezone, 'MMM d, h:mm a')}: ${authorized.filter((m) => since(m) === 'New').length} new, ${authorized.filter((m) => since(m) === 'Changed').length} changed, ${removed.length} removed.`
      : 'First version sent to this audience.';
    if (track)
      await db.exportLog.create({
        data: { conferenceId, scope, audienceId: id || null, userId: user.id, meetingIds: authorized.map((m) => m.id) },
      });
    const counterpart = (m: { issuerId: string; investorId: string }) =>
      scope === 'issuer'
        ? investors.find((x) => x.id === m.investorId)?.name || ''
        : issuers.find((x) => x.id === m.issuerId)?.name || '';
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
          'Content-Disposition': `attachment; filename="${baseName}-${slug(issuer.name)}-${slug(investor.name)}.ics"`,
          'Cache-Control': 'no-store',
        },
      });
    }
    if (q.get('format') === 'pdf') {
      const doc = new PDFDocument({ size: 'A4', margin: 34, layout: 'landscape' });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.fontSize(18).fillColor('#174f43').text(title);
      doc
        .moveDown(0.25)
        .fontSize(8)
        .fillColor('#68756d')
        .text(`${c.name} · ${c.location} · times in ${c.timezone} · ${authorized.length} confirmed meeting${authorized.length === 1 ? '' : 's'}`);
      doc.moveDown(0.2).fontSize(8).fillColor('#a16b27').text(sinceNote);
      doc.moveDown(0.8);
      const cols = clientFacing
        ? [
            { label: 'DATE', x: 34, w: 90 },
            { label: 'TIME', x: 128, w: 110 },
            { label: scope === 'issuer' ? 'INVESTOR' : 'ISSUER', x: 242, w: 200 },
            { label: 'LOCATION', x: 446, w: 300 },
          ]
        : [
            { label: 'DATE', x: 34, w: 70 },
            { label: 'TIME', x: 108, w: 86 },
            { label: 'INVESTOR', x: 198, w: 92 },
            { label: 'ISSUER', x: 294, w: 92 },
            { label: 'COVERAGE 1', x: 390, w: 86 },
            { label: 'COVERAGE 2', x: 480, w: 86 },
            { label: 'ROOM', x: 570, w: 100 },
            { label: 'STATUS', x: 674, w: 86 },
          ];
      const header = () => {
        const y = doc.y;
        doc.fontSize(7).fillColor('#174f43');
        for (const col of cols) doc.text(col.label, col.x, y, { width: col.w, lineBreak: false });
        doc.y = y + 12;
        doc.strokeColor('#dfe5dd').moveTo(34, doc.y).lineTo(760, doc.y).stroke();
        doc.y += 6;
      };
      header();
      let lastDay = '';
      for (const m of authorized) {
        if (doc.y > 525) {
          doc.addPage();
          header();
        }
        const rowY = doc.y;
        const cov = coverage.filter((a) => a.meetingId === m.id);
        const room = roomAssignments.find((a) => a.meetingId === m.id);
        const cube = cubes.find((x) => x.id === room?.cubeId);
        const person = (bankerId: string) => people.find((p) => p.id === bankerId)?.name || 'Unassigned';
        const ordered = [...cov.filter((a) => a.coverageRole === 'Primary'), ...cov.filter((a) => a.coverageRole !== 'Primary')];
        const day = formatInTimeZone(m.start, c.timezone, 'EEE, MMM d');
        const time = `${formatInTimeZone(m.start, c.timezone, 'h:mm a')} – ${formatInTimeZone(m.end, c.timezone, 'h:mm a')}`;
        const investor = investors.find((x) => x.id === m.investorId)?.name || '';
        const issuer = issuers.find((x) => x.id === m.issuerId)?.name || '';
        const place =
          [cube?.name, m.location && !m.location.startsWith(cube?.name || '\u0000') ? m.location : '']
            .filter(Boolean)
            .join(' · ') || 'To be confirmed';
        const ready = cov.length >= 2 && (!m.requiresCube || cube);
        const cells = clientFacing
          ? [day === lastDay ? '' : day, since(m) ? `${time}  · ${since(m).toUpperCase()}` : time, scope === 'issuer' ? investor : issuer, place]
          : [
              day === lastDay ? '' : day,
              time,
              investor,
              issuer,
              ordered[0] ? person(ordered[0].bankerId) : 'UNASSIGNED',
              ordered[1] ? person(ordered[1].bankerId) : 'UNASSIGNED',
              cube?.name || m.location || 'UNASSIGNED',
              ready ? 'READY' : 'NEEDS REVIEW',
            ];
        lastDay = day;
        doc.fontSize(8);
        cells.forEach((text, i) => {
          const isStatus = !clientFacing && i === cells.length - 1;
          doc.fillColor(isStatus ? (ready ? '#32725b' : '#a16b27') : '#33453b').text(text, cols[i].x, rowY, { width: cols[i].w });
        });
        doc.y = rowY + 22;
        doc.strokeColor('#edf0ec').moveTo(34, doc.y).lineTo(760, doc.y).stroke();
        doc.y += 6;
      }
      if (!authorized.length) doc.fontSize(9).fillColor('#68756d').text('No confirmed meetings yet.', 34, doc.y);
      if (removed.length) {
        doc.moveDown(0.6).fontSize(9).fillColor('#a33a2b').text('Removed since last sent', 34, doc.y);
        for (const m of removed)
          doc.fontSize(8).fillColor('#33453b').text(`${formatInTimeZone(m.start, c.timezone, 'EEE, MMM d h:mm a')} · ${counterpart(m)}${m.status === 'Cancelled' ? ' (cancelled)' : ''}`, 34, doc.y);
      }
      doc.end();
      const pdf = await new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
      return new Response(new Uint8Array(pdf), { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${baseName}.pdf"`, 'Cache-Control': 'no-store' } });
    }
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Corda AI';
    const sheet = wb.addWorksheet(clientFacing ? 'Planner' : 'Conference Planner');
    // Column order requested by the desk: who meets whom, when, and which two bankers cover it.
    sheet.columns = clientFacing ? [
      { header: 'Date', key: 'date', width: 13 },
      { header: 'Time', key: 'time', width: 15 },
      { header: scope === 'issuer' ? 'Investor' : 'Issuer', key: 'counterpart', width: 30 },
      { header: 'Location', key: 'place', width: 32 },
      { header: 'Since last sent', key: 'since', width: 16 },
    ] : [
      { header: 'Date', key: 'date', width: 13 },
      { header: 'Time', key: 'time', width: 15 },
      { header: 'Investor Name', key: 'investor', width: 26 },
      { header: 'Issuer Name', key: 'issuer', width: 26 },
      { header: 'Banker Coverage 1', key: 'coverage1', width: 22 },
      { header: 'Banker Coverage 2', key: 'coverage2', width: 22 },
      { header: 'Meeting Room', key: 'cube', width: 22 },
      { header: 'Location', key: 'location', width: 22 },
      { header: 'Status', key: 'status', width: 18 },
      { header: 'Timezone', key: 'timezone', width: 22 },
      ...(clientFacing
        ? []
        : [
            { header: 'Meeting ID', key: 'id', width: 28 },
            { header: 'Approved recipients', key: 'recipients', width: 40 },
          ]),
      { header: 'Since last sent', key: 'since', width: 16 },
    ];
    for (const m of authorized) {
      const i = issuers.find((x) => x.id === m.issuerId)!, v = investors.find((x) => x.id === m.investorId)!;
      const cov = coverage.filter((a) => a.meetingId === m.id), room = roomAssignments.find((a) => a.meetingId === m.id), cube = cubes.find((x) => x.id === room?.cubeId);
      const person = (bankerId: string) => people.find((p) => p.id === bankerId)?.name || bankerId;
      const ordered = [...cov.filter((a) => a.coverageRole === 'Primary'), ...cov.filter((a) => a.coverageRole !== 'Primary')];
      const place = [cube?.name, m.location && !m.location.startsWith(cube?.name || '\u0000') ? m.location : ''].filter(Boolean).join(' · ') || 'To be confirmed';
      if (clientFacing) {
        sheet.addRow({
          date: formatInTimeZone(m.start, c.timezone, 'EEE, MMM d'),
          time: `${formatInTimeZone(m.start, c.timezone, 'h:mm a')} – ${formatInTimeZone(m.end, c.timezone, 'h:mm a')}`,
          counterpart: safe(scope === 'issuer' ? v.name : i.name),
          place: safe(place),
          since: since(m),
        });
        continue;
      }
      sheet.addRow({
        since: since(m),
        date: formatInTimeZone(m.start, c.timezone, 'yyyy-MM-dd'),
        time: `${formatInTimeZone(m.start, c.timezone, 'HH:mm')}–${formatInTimeZone(m.end, c.timezone, 'HH:mm')}`,
        investor: safe(v.name),
        issuer: safe(i.name),
        coverage1: ordered[0] ? safe(person(ordered[0].bankerId)) : 'UNASSIGNED',
        coverage2: ordered[1] ? safe(person(ordered[1].bankerId)) : 'UNASSIGNED',
        cube: cube?.name || 'UNASSIGNED',
        location: safe(m.location || ''),
        status: cov.length >= 2 && (!m.requiresCube || cube) ? m.status : 'Needs resources',
        timezone: c.timezone,
        id: m.id,
        recipients: recipient ? recipient : m.approvedRecipients.join(', '),
      });
    }
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF123D35' } };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: 'A1', to: clientFacing ? 'E1' : 'M1' };
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      if (row.getCell('since').value) row.getCell('since').font = { bold: true, color: { argb: 'FF9A5B00' } };
      if (!clientFacing && row.getCell('status').value === 'Needs resources') row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF1D6' } };
    });
    if (removed.length) {
      sheet.addRow([]);
      sheet.addRow(['Removed since last sent']).font = { bold: true, color: { argb: 'FFA33A2B' } };
      for (const m of removed)
        sheet.addRow([formatInTimeZone(m.start, c.timezone, 'EEE, MMM d'), formatInTimeZone(m.start, c.timezone, 'h:mm a'), safe(counterpart(m)), m.status === 'Cancelled' ? 'Cancelled' : 'Removed']);
    }
    const info = wb.addWorksheet('Read me');
    info.addRow(['Title', `${c.name} — ${title}`]);
    info.addRow(['Audience', recipient || 'Internal authenticated user']);
    info.addRow(['Scope', scope]);
    info.addRow(['Timezone', c.timezone]);
    info.addRow(['Since last sent', sinceNote]);
    info.addRow([
      'Note',
      'Only confirmed meetings are included. Excel is an export artifact; the database is the source of truth.',
    ]);
    const buffer = await wb.xlsx.writeBuffer();
    return new Response(new Uint8Array(buffer as ArrayBuffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${baseName}.xlsx"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
