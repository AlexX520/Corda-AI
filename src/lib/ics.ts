import { formatInTimeZone } from 'date-fns-tz';
const icsText = (s: string) =>
  s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\;');
export function meetingIcs(
  m: { id: string; start: Date; end: Date; updatedAt: Date; location: string },
  issuer: string,
  investor: string,
  conference: { name: string; timezone: string },
) {
  const utc = (d: Date) => formatInTimeZone(d, 'UTC', "yyyyMMdd'T'HHmmss'Z'");
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Corda AI//Conference desk//EN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${m.id}@corda.ai`,
    `DTSTAMP:${utc(m.updatedAt)}`,
    `DTSTART:${utc(m.start)}`,
    `DTEND:${utc(m.end)}`,
    `SUMMARY:${icsText(`${issuer} × ${investor} | ${conference.name}`)}`,
    `LOCATION:${icsText(m.location)}`,
    `DESCRIPTION:${icsText(`Conference timezone: ${conference.timezone}`)}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}
