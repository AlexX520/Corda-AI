/**
 * Turns a sales one-liner such as "Bayview / Ford looking to meet 3-4pm Monday?" into a
 * structured meeting request. Deterministic on purpose: it only fills what the sentence states
 * and lists what is missing, so sales can correct it before anything is submitted.
 */
import { eachDayOfInterval, format, parseISO } from 'date-fns';

type Named = { id: string; name: string };
export type ParsedRequest = {
  issuerId: string | null;
  investorId: string | null;
  date: string | null; // conference-local yyyy-MM-dd
  windowStart: string | null; // HH:mm
  windowEnd: string | null; // HH:mm
  duration: number;
  missing: string[];
};

const GENERIC = new Set([
  'capital', 'financial', 'credit', 'management', 'mortgage', 'price', 'group', 'partners',
  'investments', 'asset', 'bank', 'the', 'and', 'of',
]);

/** Names people actually type: full name, name without generic suffixes, first distinctive word. */
function aliases(name: string) {
  const clean = name.toLowerCase().replace(/[.,]/g, '');
  const words = clean.split(/\s+/);
  const core = words.filter((w) => !GENERIC.has(w));
  const set = new Set([clean]);
  if (core.length && core.join(' ') !== clean) set.add(core.join(' '));
  if (core[0] && core[0].length >= 4) set.add(core[0]);
  return [...set];
}

function mentions(text: string, items: Named[]) {
  const lower = ` ${text.toLowerCase().replace(/[.,]/g, '')} `;
  const hits: { id: string; at: number; len: number }[] = [];
  for (const item of items)
    for (const a of aliases(item.name)) {
      const re = new RegExp(`[^a-z0-9]${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^a-z0-9]`);
      const m = re.exec(lower);
      if (m) {
        hits.push({ id: item.id, at: m.index, len: a.length });
        break;
      }
    }
  return hits;
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseClock(raw: string, meridiem?: string) {
  const [h, m = '0'] = raw.split(':');
  let hour = Number(h);
  const min = Number(m);
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  // Conference meetings run in the daytime: a bare "3" means 3 PM.
  if (!meridiem && hour >= 1 && hour <= 6) hour += 12;
  return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function parseRequestText(
  text: string,
  ctx: {
    conference: { startDate: string; endDate: string; slotMinutes: number };
    issuers: Named[];
    investors: Named[];
  },
): ParsedRequest {
  const lower = text.toLowerCase();
  const issuerHits = mentions(text, ctx.issuers);
  const investorHits = mentions(text, ctx.investors);
  // Convention from the desk: "Issuer / Investor". When a name could be either, the first
  // mention is the issuer and the other one the investor.
  const all = [
    ...issuerHits.map((h) => ({ ...h, kind: 'issuer' as const })),
    ...investorHits.map((h) => ({ ...h, kind: 'investor' as const })),
  ].sort((a, b) => a.at - b.at || b.len - a.len);
  const positions = [...new Set(all.map((h) => h.at))];
  let issuerId: string | null = null,
    investorId: string | null = null,
    issuerAt = -1;
  for (const at of positions) {
    const i = all.find((h) => h.at === at && h.kind === 'issuer');
    if (i) {
      issuerId = i.id;
      issuerAt = at;
      break;
    }
  }
  for (const at of positions) {
    if (at === issuerAt) continue;
    const v = all.find((h) => h.at === at && h.kind === 'investor');
    if (v) {
      investorId = v.id;
      break;
    }
  }

  const days = eachDayOfInterval({
    start: parseISO(ctx.conference.startDate),
    end: parseISO(ctx.conference.endDate),
  }).map((d) => format(d, 'yyyy-MM-dd'));
  let date: string | null = null;
  const dayWord = lower.match(
    /\b(mon|tue|wed|thu|fri|sat|sun)(?:day|s|sday|nesday|rsday|r|urday)?\b/,
  );
  if (dayWord) date = days.find((d) => DAYS[parseISO(d).getDay()] === dayWord[1]) || null;
  const numeric = lower.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (!date && numeric)
    date = days.find((d) => Number(d.slice(5, 7)) === +numeric[1] && Number(d.slice(8)) === +numeric[2]) || null;
  const named = lower.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/);
  if (!date && named)
    date =
      days.find(
        (d) => format(parseISO(d), 'MMM').toLowerCase() === named[1] && Number(d.slice(8)) === +named[2],
      ) || null;
  if (!date && /\b(day one|day 1|first day)\b/.test(lower)) date = days[0];
  if (!date && days.length === 1) date = days[0];

  let windowStart: string | null = null,
    windowEnd: string | null = null;
  const range = lower.match(
    /\b(\d{1,2}(?::\d{2})?)\s*(am|pm)?\s*(?:-|–|to|until)\s*(\d{1,2}(?::\d{2})?)\s*(am|pm)?\b/,
  );
  if (range) {
    const endMer = range[4] || range[2];
    windowEnd = parseClock(range[3], endMer);
    windowStart = parseClock(range[1], range[2] || endMer);
    // "11-1pm": the start inherited PM it should not have.
    if (!range[2] && windowStart > windowEnd) windowStart = parseClock(range[1], 'am');
  } else {
    const single = lower.match(/\b(?:at\s+)?(\d{1,2}(?::\d{2})?)\s*(am|pm)\b|\bat\s+(\d{1,2}(?::\d{2})?)\b/);
    if (single) windowStart = parseClock(single[1] || single[3], single[2]);
  }
  const morning = /\bmorning\b/.test(lower),
    afternoon = /\bafternoon\b/.test(lower);
  if (!windowStart && morning) [windowStart, windowEnd] = ['09:00', '12:00'];
  if (!windowStart && afternoon) [windowStart, windowEnd] = ['13:00', '17:00'];

  const minutes = lower.match(/\b(\d{2,3})\s*(?:min|mins|minutes)\b/);
  const hours = lower.match(/\b(1|one)\s*(?:hr|hour)\b/);
  const duration = minutes ? Number(minutes[1]) : hours ? 60 : ctx.conference.slotMinutes;

  const missing = [
    !issuerId && 'issuer',
    !investorId && 'investor',
    !date && 'day',
    !windowStart && 'time',
  ].filter(Boolean) as string[];
  return { issuerId, investorId, date, windowStart, windowEnd, duration, missing };
}
