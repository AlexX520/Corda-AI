import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

/**
 * Compare syndicate's meeting-room schedule with ours (Alex: "syndicate does the room
 * allocation on their own schedule, and the final versions often don't match"). Their file is
 * read as a table; each row is matched to our meeting by issuer + investor (nearest time), and
 * every difference is listed: time, room, or a meeting only one side has.
 */
export type Cell = string | number | Date | null | undefined;
export type SyndicateRow = { line: number; issuer: string; investor: string; start: string | null; room: string; raw: string };
export type Party = { id: string; name: string };
export type OurMeeting = { id: string; issuerId: string; investorId: string; start: string; room: string };
export type Difference =
  | { kind: 'time'; meetingId: string; issuer: string; investor: string; ours: string; theirs: string; line: number }
  | { kind: 'room'; meetingId: string; issuer: string; investor: string; ours: string; theirs: string; when: string; line: number }
  | { kind: 'onlyTheirs'; issuer: string; investor: string; theirs: string; room: string; line: number }
  | { kind: 'onlyOurs'; meetingId: string; issuer: string; investor: string; ours: string; room: string }
  | { kind: 'unknown'; line: number; raw: string; reason: string };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const roomKey = (s: string) => norm(s.split('·')[0]).replace(/^(?:room|cube|meeting room)\s+/, '');

/** "Ford", "Ford Credit Co", "FORD CREDIT" → Ford Credit. */
export function matchParty(name: string, parties: Party[]): Party | null {
  const n = norm(name);
  if (!n) return null;
  return (
    parties.find((p) => norm(p.name) === n) ||
    parties.find((p) => n.startsWith(norm(p.name)) || norm(p.name).startsWith(n)) ||
    parties.find((p) => norm(p.name).split(' ')[0] === n.split(' ')[0] && n.split(' ')[0].length >= 3) ||
    null
  );
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** Date and time cells as the conference's wall clock → ISO instant. */
export function parseWhen(dateCell: Cell, timeCell: Cell, zone: string, defaultDay: string): string | null {
  let day: string | null = null,
    hh: number | null = null,
    mm = 0;
  const fromDate = (d: Date) => {
    // Spreadsheet dates carry the wall clock in UTC fields.
    day = d.toISOString().slice(0, 10);
    if (d.getUTCHours() || d.getUTCMinutes()) {
      hh = d.getUTCHours();
      mm = d.getUTCMinutes();
    }
  };
  const readText = (t: string) => {
    const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
    const us = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(t);
    const named = new RegExp(`\\b(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{1,2})\\b`, 'i').exec(t);
    const year = defaultDay.slice(0, 4);
    if (iso) day = `${iso[1]}-${iso[2]}-${iso[3]}`;
    else if (named) day = `${year}-${String(MONTHS.indexOf(named[1].toLowerCase().slice(0, 3)) + 1).padStart(2, '0')}-${named[2].padStart(2, '0')}`;
    else if (us) day = `${us[3] ? (us[3].length === 2 ? `20${us[3]}` : us[3]) : year}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
    const tm = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?=\s|$|[^\d/])/i.exec(t.replace(/(\d{4})-(\d{2})-(\d{2})|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?/g, ' '));
    if (tm && (tm[2] || tm[3])) {
      hh = Number(tm[1]) % 12 + (/p/i.test(tm[3] || '') ? 12 : 0);
      if (!tm[3]) hh = Number(tm[1]);
      mm = Number(tm[2] || 0);
    }
  };
  for (const c of [dateCell, timeCell]) {
    if (c instanceof Date) fromDate(c);
    else if (typeof c === 'number' && c < 1) {
      // Excel time fraction of a day.
      hh = Math.floor(c * 24);
      mm = Math.round((c * 24 - hh) * 60);
    } else if (c != null && String(c).trim()) readText(String(c));
  }
  if (hh === null) return null;
  const d = day || defaultDay;
  return fromZonedTime(`${d}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`, zone).toISOString();
}

/** Find the header row and read every row below it. */
export function readTable(table: Cell[][], zone: string, defaultDay: string): { rows: SyndicateRow[]; missing: string[] } {
  const headerAt = table.findIndex((r) => {
    const h = r.map((c) => norm(String(c ?? '')));
    return h.some((x) => /issuer|company|corporate/.test(x)) && h.some((x) => /investor|account|client|fund/.test(x));
  });
  if (headerAt < 0) return { rows: [], missing: ['a header row with Issuer and Investor columns'] };
  const head = table[headerAt].map((c) => norm(String(c ?? '')));
  const col = (re: RegExp) => head.findIndex((x) => re.test(x));
  const ci = col(/issuer|company|corporate/),
    cv = col(/investor|account|client|fund/),
    cd = col(/^date$|^day$|date|day/),
    ct = col(/time|start|slot/),
    cr = col(/room|cube|location|venue/);
  const missing = [ct < 0 && cd < 0 ? 'a Time column' : '', cr < 0 ? 'a Room column' : ''].filter(Boolean);
  const rows: SyndicateRow[] = [];
  table.slice(headerAt + 1).forEach((r, i) => {
    const issuer = String(r[ci] ?? '').trim(),
      investor = String(r[cv] ?? '').trim();
    if (!issuer && !investor) return;
    rows.push({
      line: headerAt + i + 2,
      issuer,
      investor,
      start: parseWhen(cd >= 0 ? r[cd] : null, ct >= 0 ? r[ct] : null, zone, defaultDay),
      room: cr >= 0 ? String(r[cr] ?? '').trim() : '',
      raw: r.map((c) => (c instanceof Date ? c.toISOString().slice(0, 16).replace('T', ' ') : String(c ?? ''))).filter(Boolean).join(' · '),
    });
  });
  return { rows, missing };
}

export function compareSchedules(
  rows: SyndicateRow[],
  ours: OurMeeting[],
  issuers: Party[],
  investors: Party[],
  zone: string,
): { matched: number; differences: Difference[] } {
  const when = (iso: string) => formatInTimeZone(iso, zone, 'EEE MMM d, h:mm a');
  const iname = (id: string) => issuers.find((x) => x.id === id)?.name || id;
  const vname = (id: string) => investors.find((x) => x.id === id)?.name || id;
  const used = new Set<string>();
  const differences: Difference[] = [];
  let matched = 0;
  for (const r of rows) {
    const issuer = matchParty(r.issuer, issuers),
      investor = matchParty(r.investor, investors);
    if (!issuer || !investor) {
      differences.push({ kind: 'unknown', line: r.line, raw: r.raw, reason: !issuer ? `Issuer "${r.issuer}" not found` : `Investor "${r.investor}" not found` });
      continue;
    }
    const pool = ours.filter((m) => m.issuerId === issuer.id && m.investorId === investor.id && !used.has(m.id));
    const t = r.start ? +new Date(r.start) : null;
    const m = pool.sort((a, b) => (t === null ? 0 : Math.abs(+new Date(a.start) - t) - Math.abs(+new Date(b.start) - t)))[0];
    if (!m) {
      differences.push({ kind: 'onlyTheirs', issuer: issuer.name, investor: investor.name, theirs: r.start ? when(r.start) : 'no time', room: r.room, line: r.line });
      continue;
    }
    used.add(m.id);
    matched++;
    if (r.start && +new Date(r.start) !== +new Date(m.start))
      differences.push({ kind: 'time', meetingId: m.id, issuer: issuer.name, investor: investor.name, ours: when(m.start), theirs: when(r.start), line: r.line });
    if (r.room && roomKey(r.room) !== roomKey(m.room))
      differences.push({ kind: 'room', meetingId: m.id, issuer: issuer.name, investor: investor.name, ours: m.room || 'no room', theirs: r.room, when: when(m.start), line: r.line });
  }
  for (const m of ours.filter((x) => !used.has(x.id)))
    differences.push({ kind: 'onlyOurs', meetingId: m.id, issuer: iname(m.issuerId), investor: vname(m.investorId), ours: when(m.start), room: m.room });
  return { matched, differences };
}

/** Simple CSV (quoted fields, commas or tabs). */
export function parseCsv(text: string): string[][] {
  const sep = text.split('\n')[0].includes('\t') && !text.split('\n')[0].includes(',') ? '\t' : ',';
  const out: string[][] = [];
  let row: string[] = [],
    cell = '',
    q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) row.push(cell), (cell = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      out.push(row);
      (row = []), (cell = '');
    } else cell += ch;
  }
  if (cell || row.length) row.push(cell), out.push(row);
  return out;
}
