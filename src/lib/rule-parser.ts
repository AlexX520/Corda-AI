/**
 * Deterministic email parser. Runs when no LLM key is configured and as the fallback when the
 * model fails, so it errs on the side of asking: it only produces a time window when the email
 * states it exactly, and it never guesses an entity that is ambiguous.
 *
 * Pipeline: clean the new content (no quoted history, greeting or signature) → split it into
 * segments (numbered/bulleted lines, else sentences and ";" clauses) → classify each segment's
 * operation → group segments into asks (a segment with no operation verb continues the previous
 * ask) → parse each ask's entities, dates, times and time zones.
 */
import { addDays, format, parseISO } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { conferenceTime } from './scheduling';
import {
  extractionSchema,
  type Context,
  type Extraction,
  type ExtractionWindow,
  type Hints,
  type MissingFact,
} from './extraction-schema';
import { askSummary } from './review-rules';

export function newEmailContent(body: string) {
  return body
    .split(
      /\r?\n(?:On .{1,250}wrote:|From:|_{5,}|-{2,}\s*(?:Original Message|Forwarded message)|-{5,}\s*Forwarded)/i,
    )[0]
    .split(/\r?\n>/)[0]
    .trim();
}

/* ---------------------------------------------------------------- forwarded messages */

const FWD_MARK =
  /\r?\n[ \t>]*(?:-{2,}\s*(?:Original Message|Forwarded message)\s*-*|_{5,}|Begin forwarded message:)[ \t]*\r?\n/i;
const HEADER = /^[ \t>]*(From|Sent|Date|To|Cc|Subject):[ \t]*(.*)$/i;
export type Forwarded = { fromName: string | null; fromEmail: string | null; subject: string | null; body: string };
/** The short note on top of a forward and the message that was forwarded (with its own From). */
export function splitForward(body: string): { note: string; forwarded: Forwarded | null } {
  const m = FWD_MARK.exec(`\n${body}`);
  if (!m) return { note: body.trim(), forwarded: null };
  const at = Math.max(0, m.index - 1);
  const note = body.slice(0, at).trim();
  const lines = body.slice(at + m[0].length - 1).replace(/^\r?\n/, '').split(/\r?\n/);
  const headers: Record<string, string> = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const h = HEADER.exec(lines[i]);
    if (h) headers[h[1].toLowerCase()] = h[2].trim();
    else if (Object.keys(headers).length && !lines[i].trim()) break;
    else if (Object.keys(headers).length) break;
    else if (lines[i].trim()) break;
  }
  const from = headers.from || '';
  const email = /<?([\w.+-]+@[\w-]+(?:\.[\w-]+)+)>?/.exec(from)?.[1]?.toLowerCase() || null;
  const name = from.replace(/<[^>]*>/, '').replace(/[\w.+-]+@[\w.-]+/, '').replace(/["']/g, '').trim() || null;
  const rest = lines
    .slice(i)
    .join('\n')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .trim();
  return { note, forwarded: rest ? { fromName: name, fromEmail: email, subject: headers.subject || null, body: rest } : null };
}

/* ---------------------------------------------------------------- text preparation */

const SIGNOFF =
  /^\s*(?:thanks|thank you|thx|many thanks|best|best regards|kind regards|regards|warm regards|cheers|sincerely|sent from my|--\s*$)\b[^\n]{0,30}$/i;
const GREETING =
  /^\s*(?:hi|hello|hey|dear|good (?:morning|afternoon))?\b[^\n.!?]{0,30}[,\-–—:!]\s*$/i;

type Prepared = { text: string; scan: string };
/** `scan` is `text` with the same length, normalised for matching (a.m. → am, duplicate times masked). */
function prepare(body: string): Prepared {
  let text = newEmailContent(body);
  const lines = text.split('\n');
  const cut = lines.findIndex((l, i) => i > 0 && SIGNOFF.test(l));
  if (cut > 0) text = lines.slice(0, cut).join('\n').trimEnd();
  let scan = text.replace(/\b([ap])\.\s?m\.?/gi, (m, x: string) => `${x}m`.padEnd(m.length, ' '));
  // "2:30pm ET (7:30pm UK)": the bracketed time repeats the same moment in another zone.
  scan = scan.replace(/\(\s*\d{1,2}(?::\d{2})?\s*(?:[ap]m)?[^)\n\d]{0,24}\)/gi, (m) =>
    /\d{1,2}(?::\d{2}|\s*[ap]m)/i.test(m) ? ' '.repeat(m.length) : m,
  );
  // Greeting line ("Sarah, all -") carries no ask.
  const first = scan.split('\n')[0];
  if (GREETING.test(first) && first.trim().split(/\s+/).length <= 5)
    scan = ' '.repeat(first.length) + scan.slice(first.length);
  return { text, scan };
}

type Seg = { start: number; end: number; item: boolean };
const ITEM = /^\s*(?:\(?\d{1,2}[.)]|[-*•])\s+/;
function sentenceSegs(scan: string, from: number, to: number, item = false): Seg[] {
  const out: Seg[] = [];
  let s = from;
  const push = (e: number) => {
    const piece = scan.slice(s, e);
    if (piece.trim()) {
      const lead = piece.length - piece.trimStart().length,
        trail = piece.length - piece.trimEnd().length;
      out.push({ start: s + lead, end: e - trail, item });
    }
  };
  for (let i = from; i < to; i++) {
    const ch = scan[i];
    if (
      ch === '\n' ||
      ch === ';' ||
      ((ch === '.' || ch === '!' || ch === '?') && /\s/.test(scan[i + 1] || ' '))
    ) {
      push(ch === '\n' ? i : i + 1);
      s = i + 1;
    }
  }
  push(to);
  return out;
}
function segment(scan: string): Seg[] {
  const lines: { start: number; end: number }[] = [];
  let at = 0;
  for (const l of scan.split('\n')) {
    lines.push({ start: at, end: at + l.length });
    at += l.length + 1;
  }
  const items = lines.filter((l) => ITEM.test(scan.slice(l.start, l.end)));
  if (items.length < 2) return sentenceSegs(scan, 0, scan.length);
  // A numbered/bulleted list: every item is its own ask; other lines are read sentence by sentence.
  const out: Seg[] = [];
  for (const l of lines) {
    const line = scan.slice(l.start, l.end);
    if (!line.trim()) continue;
    if (ITEM.test(line))
      out.push({ start: l.start + (line.match(ITEM)?.[0].length || 0), end: l.end, item: true });
    else out.push(...sentenceSegs(scan, l.start, l.end));
  }
  return out;
}

/* ---------------------------------------------------------------- classification */

type Op =
  | 'reschedule'
  | 'cancel'
  | 'request'
  | 'confirm'
  | 'update'
  | 'availability'
  | 'nochange'
  | null;
const RESCHEDULE =
  /\b(?:reschedul\w*|move|moved|moving|push(?:ed|ing)?|shift(?:ed|ing)?|bring (?:it |that |the meeting )?forward|instead do|do [^.?]{0,20}instead)\b|\binstead of\b(?=[^.]*\b(?:meeting|1x1|slot)\b)/i;
/** "She'd prefer 3:30 if Fidelity can do it": a conditional move to a preferred time. */
const PREFER = /\bprefer\b[^.]{0,40}\d/i;
const CANCEL =
  /\b(?:cancel\w*|call(?:ing)? off|drop (?:the|our|that|it|anything)|drop\b(?=[^.]{0,30}\b(?:meeting|request|1x1|slot)\b)|scrap|won'?t be (?:able to )?(?:attend|make)(?: it)?)\b/i;
/** A move or cancellation is an ask only when someone asks for it, not when it is narrated. */
const CUE =
  /\b(?:can|could|would|will you|please|pls|plz|kindly|let'?s|needs? to|want to|like to|we'?d|asks?|asked to|have to|must|instead)\b|\?|^\W*(?:\d+\W+)?(?:cancel|move|reschedule|push|drop|shift)\b/i;
const TO_TIME = /\b(?:to|until)\s+(?:(?:mon|tue|wed|thu|fri)[a-z]*\b|\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b)/i;
const REQUEST =
  /\b(?:add\b(?!-)(?![^.]{0,25}\b(?:availability|availabilities|times|windows|hours|to (?:the|our|your) (?:schedule|calendar|grid))\b)|request(?:ing)? (?:a |an )?(?:meeting|1x1|slot)|would (?:also )?(?:like|love) (?:a|an|to (?:meet|see|request|add|set up|schedule|have))\b|(?:second|2nd|another|separate|additional) (?:slot|meeting|1x1)|set up (?:a |an )?(?:1x1|meeting)|1x1s? with|meeting with|meet with|slot with|(?:can|could) we (?:get|have|book|fit|squeeze|set up|do a)\b|wants? to (?:see|meet)|offer (?:it|that|the [^.]{0,30}?) to|fit (?:them|it) in|^\W*new:)/i;
const UPDATE =
  /\b(?:now have|will (?:now )?(?:have|be)|we'?ll (?:now )?(?:have|be)|headcount|bringing|party of)\b[^.]{0,30}\b(?:\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b[^.]{0,12}\b(?:people|of us|attendees|ppl|pax|persons)?/i;
const CONFIRM = /\b(?:confirms|confirmed|we confirm|confirming|is confirmed|agree to|accepts?)\b/i;
const NOT_CONFIRM =
  /\b(?:thanks? (?:you )?for confirming|please confirm|pls confirm|can you confirm|could you confirm|confirm by|to confirm)\b/i;
const NOCHANGE =
  /\b(?:unchanged|as is|still (?:on|ok|okay|good|fine|works?)|stays? (?:on|as|at)|keep (?:that|it|this|that one|them)|no change)\b/i;
const AVAIL =
  /\b(?:availab\w*|accommodate|take meetings|can (?:only )?(?:do|meet|take)|could do|works? for (?:us|me)|free\b|open\b|block(?:ed)?|no longer|not before|nothing (?:before|after)|(?:does|do|will)(?: not|n't) work|won'?t work|not work|can(?:no|')t do|out of office)/i;
/** Ask is applied only if a condition holds ("if 2:30 doesn't work", "or we'd rather", "else keep 3"). */
const CONDITIONAL =
  /\b(?:if [^,.]{0,40}(?:doesn'?t|does not|can'?t|cannot|won'?t|can) (?:work|do it|make it|fit)|or we'?d rather|we'?d rather|else keep|unless\b)/i;
function classify(s: string): Op {
  const cue = CUE.test(s) || TO_TIME.test(s);
  // "please do not move it again", "moved twice" (narration) are not move asks.
  const noMove = /\b(?:do not|don'?t|never|not) (?:move|reschedule|shift|push)\b|\bif it (?:moves|is moved)\b/i.test(s);
  if (RESCHEDULE.test(s) && cue && !noMove) return 'reschedule';
  if (CANCEL.test(s) && cue) return 'cancel';
  if (REQUEST.test(s)) return 'request';
  if (PREFER.test(s)) return 'reschedule';
  if (UPDATE.test(s)) return 'update';
  if (CONFIRM.test(s) && !NOT_CONFIRM.test(s)) return 'confirm';
  if (NOCHANGE.test(s)) return 'nochange';
  if (AVAIL.test(s)) return 'availability';
  return null;
}
const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/* ---------------------------------------------------------------- entities */

type Named = { id: string; name: string };
type Mention = { id: string; index: number; end: number };
const SUFFIX =
  /\s+(?:Management|Financial|Mortgage|Credit|Investments?|Capital|Group|Partners|Inc\.?|LLC)$/i;
function aliases(name: string) {
  const out = [name];
  const short = name.replace(SUFFIX, '');
  if (short !== name && short.length >= 2) out.push(short);
  // "GM Financial" → "GMF": an acronym first word plus the initial of the rest.
  const words = name.split(/\s+/);
  if (words.length === 2 && /^[A-Z]{2,4}$/.test(words[0])) out.push(`${words[0]}${words[1][0]}`);
  return out;
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function mentions(scan: string, items: Named[]): Mention[] {
  const out: Mention[] = [];
  for (const item of items)
    for (const a of aliases(item.name)) {
      // Plain capitalised words ("Discover", "Ally") only match capitalised, to skip "discover the".
      const flags = /^[A-Z][a-z]+$/.test(a) ? 'g' : 'gi';
      for (const m of scan.matchAll(new RegExp(`\\b${escapeRe(a)}\\b`, flags)))
        out.push({ id: item.id, index: m.index!, end: m.index! + m[0].length });
    }
  return out.sort((a, b) => a.index - b.index);
}
const unique = (ms: Mention[]) => {
  const ids = [...new Set(ms.map((m) => m.id))];
  return ids.length === 1 ? ids[0] : null;
};
const within = (ms: Mention[], segs: { start: number; end: number }[]) =>
  ms.filter((m) => segs.some((s) => m.index >= s.start && m.index < s.end));

/* ---------------------------------------------------------------- dates and times */

const ZONES: [RegExp, string][] = [
  [/^(?:ET|EST|EDT|Eastern(?:\s+time)?|New York time|NY time|NYC time)$/i, 'America/New_York'],
  [/^(?:PT|PST|PDT|Pacific(?:\s+time)?)$/i, 'America/Los_Angeles'],
  [/^(?:CT|CST|CDT|Central(?:\s+time)?)$/i, 'America/Chicago'],
  [/^(?:MT|MST|MDT|Mountain(?:\s+time)?)$/i, 'America/Denver'],
  [/^(?:UK(?:\s+time)?|BST|GMT|London(?:\s+time)?)$/i, 'Europe/London'],
];
const ZONE_AFTER =
  /^\s*(ET|EST|EDT|Eastern(?:\s+time)?|New York time|NY time|NYC time|PT|PST|PDT|Pacific(?:\s+time)?|CT|CST|CDT|Central(?:\s+time)?|MT|MST|MDT|Mountain(?:\s+time)?|UK(?:\s+time)?|BST|GMT|London(?:\s+time)?)\b/i;
function zoneAfter(scan: string, at: number) {
  const m = ZONE_AFTER.exec(scan.slice(at, at + 24));
  if (!m) return null;
  return ZONES.find(([re]) => re.test(m[1].trim()))?.[1] || null;
}
type DayTok = {
  index: number;
  end: number;
  weekday?: number;
  date?: string;
  relative?: number;
  raw: string;
};
const WEEKDAYS: Record<string, number> = {
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  saturday: 6,
  sunday: 0,
};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function dayTokens(scan: string, year: string): DayTok[] {
  const out: DayTok[] = [];
  for (const m of scan.matchAll(
    /\b(?:(mon)(?:day)?|(tue)(?:s|sday)?|(wed)(?:s|nesday)?|(thu)(?:rs?|rsday)?|(fri)(?:day)?|(saturday)|(sunday))\b\.?/gi,
  )) {
    const key = m.slice(1).find(Boolean)!.toLowerCase();
    out.push({ index: m.index!, end: m.index! + m[0].length, weekday: WEEKDAYS[key], raw: m[0] });
  }
  for (const m of scan.matchAll(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?!\s*(?:am|pm|:))/gi,
  )) {
    const month = MONTHS.indexOf(m[1].toLowerCase().slice(0, 3)) + 1;
    out.push({
      index: m.index!,
      end: m.index! + m[0].length,
      date: `${year}-${String(month).padStart(2, '0')}-${m[2].padStart(2, '0')}`,
      raw: m[0],
    });
  }
  for (const m of scan.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g))
    if (+m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31)
      out.push({
        index: m.index!,
        end: m.index! + m[0].length,
        date: `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`,
        raw: m[0],
      });
  for (const m of scan.matchAll(
    /\b(today|tonight|this (?:morning|afternoon|evening)|tomorrow|tmrw|tmw|tmr)\b/gi,
  ))
    out.push({
      index: m.index!,
      end: m.index! + m[0].length,
      relative: /^(?:tomorrow|tmrw|tmw|tmr)$/i.test(m[1]) ? 1 : 0,
      raw: m[0],
    });
  // "Tuesday, October 20": the explicit date wins over the weekday next to it.
  const dated = out.filter((t) => t.date);
  return out
    .filter(
      (t) =>
        t.weekday === undefined ||
        !dated.some((d) => Math.abs(d.index - t.end) <= 3 || Math.abs(t.index - d.end) <= 3),
    )
    .sort((a, b) => a.index - b.index);
}
type Conf = Context['conferences'][number];
function resolveDay(
  t: DayTok,
  conference: Conf | undefined,
  receivedAt?: string,
): { date?: string; error?: string; note?: string } {
  if (t.relative !== undefined) {
    const zone = conference?.timezone || 'America/New_York';
    const base = formatInTimeZone(
      receivedAt ? new Date(receivedAt) : new Date(),
      zone,
      'yyyy-MM-dd',
    );
    const date = format(addDays(parseISO(base), t.relative), 'yyyy-MM-dd');
    if (!conference || date < conference.startDate || date > conference.endDate)
      return {
        error: `“${t.raw}” is relative to when the email was sent and does not fall on a conference day.`,
      };
    return { date, note: `“${t.raw}” read as ${date} (from the time the email arrived).` };
  }
  if (!conference) return { error: 'A time has no unambiguous conference date.' };
  if (t.date) {
    if (t.date < conference.startDate || t.date > conference.endDate)
      return { error: `${t.raw} is outside the conference dates.` };
    return { date: t.date };
  }
  const dates: string[] = [];
  for (
    let d = parseISO(conference.startDate);
    format(d, 'yyyy-MM-dd') <= conference.endDate;
    d = addDays(d, 1)
  )
    if (d.getDay() === t.weekday) dates.push(format(d, 'yyyy-MM-dd'));
  if (dates.length !== 1)
    return { error: `Cannot resolve ${t.raw.replace(/\.$/, '')} to one conference date.` };
  return { date: dates[0] };
}
type TimeTok = {
  index: number;
  end: number;
  kind: 'range' | 'single';
  from: string; // HH:mm
  to?: string; // HH:mm, ranges only
  connector?: string;
  zone: string | null;
  raw: string;
  error?: string;
};
const clock = (h: string, m: string | undefined, mer: string) =>
  `${String((Number(h) % 12) + (mer.toLowerCase() === 'pm' ? 12 : 0)).padStart(2, '0')}:${m || '00'}`;
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
function timeTokens(scan: string): TimeTok[] {
  const out: TimeTok[] = [];
  const taken: [number, number][] = [];
  const range =
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(and|to|–|—|-)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi;
  for (const m of scan.matchAll(range)) {
    const index = m.index!,
      end = index + m[0].length;
    taken.push([index, end]);
    const tok: TimeTok = {
      index,
      end,
      kind: 'range',
      from: '',
      connector: m[4].toLowerCase(),
      zone: zoneAfter(scan, end),
      raw: m[0],
    };
    if (
      [Number(m[1]), Number(m[5])].some((h) => h < 1 || h > 12) ||
      [Number(m[2] || 0), Number(m[6] || 0)].some((x) => x > 59)
    ) {
      out.push({ ...tok, error: 'Invalid clock time.' });
      continue;
    }
    // Ranges like "2–4pm", "between 2 and 4pm" (2pm–4pm) or "11-1pm" (11am–1pm) take AM/PM
    // from the end when that gives a forward range.
    let startMer = m[3];
    if (!startMer) {
      const endMin = minutesOf(clock(m[5], m[6], m[7]));
      startMer = minutesOf(clock(m[1], m[2], m[7])) < endMin ? m[7] : 'am';
      if (minutesOf(clock(m[1], m[2], startMer)) >= endMin) {
        out.push({ ...tok, error: `Missing AM/PM for range start: “${m[0]}”` });
        continue;
      }
    }
    out.push({ ...tok, from: clock(m[1], m[2], startMer), to: clock(m[5], m[6], m[7]) });
  }
  // "10-12 ET": a range without AM/PM but with a zone, in conference hours (7–12).
  for (const m of scan.matchAll(
    /\b(\d{1,2})(?::(\d{2}))?\s*[–—-]\s*(\d{1,2})(?::(\d{2}))?(?=\s*(?:ET|EST|EDT|CT|CST|CDT|PT|PST|PDT|Eastern|Central|Pacific)\b)/g,
  )) {
    const index = m.index!,
      end = index + m[0].length;
    if (taken.some(([a, b]) => index < b && end > a)) continue;
    const [h1, h2] = [+m[1], +m[3]];
    if (h1 < 7 || h2 > 12 || h2 <= h1) continue;
    taken.push([index, end]);
    out.push({
      index,
      end,
      kind: 'range',
      from: `${String(h1).padStart(2, '0')}:${m[2] || '00'}`,
      to: `${String(h2).padStart(2, '0')}:${m[4] || '00'}`,
      connector: '-',
      zone: zoneAfter(scan, end),
      raw: m[0],
    });
  }
  const single =
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})\b(?!\s*(?:am|pm))|\b(noon|midday)\b/gi;
  for (const m of scan.matchAll(single)) {
    const index = m.index!,
      end = index + m[0].length;
    if (taken.some(([a, b]) => index < b && end > a)) continue;
    if (
      /[$/]$/.test(scan.slice(Math.max(0, index - 1), index)) ||
      /^\//.test(scan.slice(end, end + 1))
    )
      continue;
    let hhmm: string | null = null;
    let error: string | undefined;
    if (m[6]) hhmm = '12:00';
    else if (m[3]) {
      if (+m[1] < 1 || +m[1] > 12 || +(m[2] || 0) > 59) error = 'Invalid clock time.';
      else hhmm = clock(m[1], m[2], m[3]);
    } else {
      const h = +m[4],
        min = +m[5];
      if (h > 23 || min > 59) continue;
      // 24-hour style "11:00" / "14:30" is clear; "2:30" without AM/PM is read as a conference-
      // hours afternoon time (meetings do not happen at 2:30 at night).
      if (h >= 7) hhmm = `${String(h).padStart(2, '0')}:${m[5]}`;
      else if (h >= 1) hhmm = `${String(h + 12).padStart(2, '0')}:${m[5]}`;
      else error = `AM/PM not stated for “${m[0]}”.`;
    }
    out.push({
      index,
      end,
      kind: 'single',
      from: hhmm || '',
      zone: zoneAfter(scan, end),
      raw: m[0],
      error,
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

const UNAVAILABLE =
  /\b(not available|unavailable|not free|no longer (?:available|free|works?)|can(?:no|')t (?:do|make|meet|attend|take)|cannot (?:do|make|meet|attend|take)|(?:does|do|will)(?: not|n't) work|won't work|not work|out of office|busy|blocked)\b/i;
const NEGATIVE =
  /\b(nothing|no meetings?|not|unavailable|can(?:no|')t|cannot|won'?t|busy|blocked)\b/i;
const VAGUE =
  /\b(?:morning|afternoon|evening|after lunch|before lunch|lunchtime|end of (?:the )?day|EOD|later in the day|next week|any ?time)\b|~\s*\d|\d\s*-?ish\b/i;
const OFFER =
  /\b(?:available|availability|can|could|works?|free|open|prefer|ideally|would like|love|how about|any ?time|only|accommodate|take meetings|if possible|or)\b/i;
const ALTERNATIVE = /^\s*(?:otherwise|or|alternatively|if not|failing that)\b/i;
const TO_BEFORE =
  /\bto\s+(?:(?:mon|tue|wed|thu|fri)[a-z]*\.?|the|on|at|between|around|about|an?|same|day|ideally|maybe|perhaps|either|or|\d{1,2}(?:st|nd|rd|th)?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?|am|pm|,|\s)*$/i;
const PROPOSE_BEFORE =
  /\b(?:could do|can do|how about|works?|prefer|ideally|would be ideal|instead|try)\b[^.]{0,30}$/i;

/* ---------------------------------------------------------------- asks */

type Group = { segs: Seg[]; op: Op };
const COUNTERPART_OPS: Op[] = ['reschedule', 'request', 'confirm'];

type EmailInfo = {
  prepared: Prepared;
  ctx: Context;
  hints: Hints;
  issuerMentions: Mention[];
  investorMentions: Mention[];
  conference: Conf | undefined;
  /** The conference came from the mailbox or the email text (not from a fallback guess). */
  conferenceNamed: boolean;
  attendees: number | null;
  combined: string;
};

function parseAsk(group: Group, info: EmailInfo, legacyOp?: Op): Extraction {
  const { prepared, ctx, hints, conference } = info;
  const { text, scan } = prepared;
  const segs = group.segs;
  const askScan = segs.map((s) => scan.slice(s.start, s.end)).join(' ');
  const op = legacyOp !== undefined ? legacyOp : group.op;
  // Entities: what this ask names, else what the whole email names once, else the sender's company.
  const issuerHere = within(info.issuerMentions, segs);
  const issuerId =
    hints.issuerId ||
    (issuerHere.length
      ? unique(issuerHere)
      : hints.senderIssuerId || unique(info.issuerMentions) || hints.partyIssuerId || null);
  const notIssuer = (ms: Mention[]) =>
    ms.filter((m) => !info.issuerMentions.some((i) => m.index < i.end && m.end > i.index));
  const investorHere = notIssuer(within(info.investorMentions, segs));
  const investorAll = notIssuer(info.investorMentions);
  const wantsInvestor = op !== 'availability' && op !== null && op !== 'nochange';
  const investorId = investorHere.length
    ? unique(investorHere)
    : hints.senderInvestorId ||
      (wantsInvestor ? unique(investorAll) || hints.partyInvestorId || null : null);

  let category: Extraction['category'] = 'General Conference Inquiry',
    operation: Extraction['operation'] = 'inquiry';
  if (op === 'reschedule') [category, operation] = ['Reschedule Request', 'reschedule'];
  else if (op === 'cancel') [category, operation] = ['Meeting Cancellation', 'cancel'];
  else if (op === 'confirm') [category, operation] = ['Meeting Confirmation', 'confirm'];
  else if (op === 'request') category = 'New Meeting Request';
  else if (op === 'update') [category, operation] = ['Meeting Update', 'update'];
  else if (op === 'availability') {
    category = 'Issuer Availability Update';
    // "No longer" usually explains why a time stopped working; the times themselves say whether
    // they are offered or blocked, so only an explicit withdrawal removes offered windows.
    operation = /\breplace|\binstead of/i.test(askScan)
      ? 'replace'
      : /\bremove|\bwithdraw/i.test(askScan)
        ? 'remove'
        : 'add';
  } else if (!info.conferenceNamed && !issuerId && !/conference|meeting/i.test(info.combined))
    category = 'Unrelated Email';

  const uncertainties: string[] = [];
  const evidence: string[] = [];
  const windows: ExtractionWindow[] = [];
  const vague: string[] = [];
  let referenceTime: string | null = null;
  let flexible = false;
  const days = dayTokens(
    scan,
    conference?.startDate.slice(0, 4) || String(new Date().getFullYear()),
  );
  const tokens = timeTokens(scan).filter((t) =>
    segs.some((s) => t.index >= s.start && t.index < s.end),
  );
  const segOf = (i: number) => segs.find((s) => i >= s.start && i < s.end)!;
  const zoneFor = (t: TimeTok) => t.zone || conference?.timezone || 'America/New_York';
  const instant = (date: string, hhmm: string, zone: string) => {
    const at = conferenceTime(date, hhmm, zone);
    return at.toISOString();
  };
  // Day for a time: the nearest day named before it in the same sentence, else after it in the
  // same sentence, else the day carried over from the previous sentence of this ask.
  const dayAt = (index: number): DayTok | undefined => {
    let carried: DayTok | undefined;
    for (const s of segs) {
      const inSeg = days.filter((d) => d.index >= s.start && d.index < s.end);
      if (index >= s.start && index < s.end) {
        const before = inSeg.filter((d) => d.index < index).at(-1);
        const after = inSeg.find((d) => d.index > index);
        return before || after || carried;
      }
      if (inSeg.length) carried = inSeg.at(-1);
    }
    return carried;
  };
  const multiDay = (s: Seg) =>
    new Set(
      days.filter((d) => d.index >= s.start && d.index < s.end).map((d) => d.date || d.weekday),
    ).size > 1;
  const dateOf = (t: TimeTok): string | null => {
    const d = dayAt(t.index);
    if (!d) {
      uncertainties.push(
        conference
          ? `No day given for “${t.raw.trim()}”.`
          : 'A time has no unambiguous conference date.',
      );
      return null;
    }
    const r = resolveDay(d, conference, hints.receivedAt);
    if (r.error) {
      uncertainties.push(r.error);
      return null;
    }
    if (r.note) uncertainties.push(r.note);
    return r.date!;
  };
  const sentenceText = (t: TimeTok) => {
    const s = segOf(t.index);
    return text.slice(s.start, s.end);
  };
  const addWindow = (w: ExtractionWindow) => {
    if (!windows.some((x) => x.start === w.start && x.end === w.end && x.kind === w.kind))
      windows.push(w);
  };
  const durationMatch = askScan.match(
    /\b(\d{2,3})\s*(?:min|mins|minutes)\b|\b(\d(?:\.\d)?)\s*(?:hours?|hrs?)\b|\b(half an hour|an hour|one hour)\b/i,
  );
  const durationMinutes = durationMatch
    ? durationMatch[1]
      ? +durationMatch[1]
      : durationMatch[2]
        ? Math.round(+durationMatch[2] * 60)
        : /half/i.test(durationMatch[3])
          ? 30
          : 60
    : null;
  const slotLength = durationMinutes || 30;

  const usable = tokens.filter((t) => {
    if (t.error) uncertainties.push(t.error);
    return !t.error;
  });
  if (
    category === 'Issuer Availability Update' ||
    category === 'General Conference Inquiry' ||
    op === null
  ) {
    for (const t of usable) {
      const seg = segOf(t.index);
      const sentence = sentenceText(t);
      if (t.kind === 'range') {
        evidence.push(sentence);
        if (multiDay(seg)) {
          uncertainties.push(
            `Multiple days in one sentence require manual interval verification: “${sentence}”`,
          );
          continue;
        }
        const date = dateOf(t);
        if (!date) continue;
        const zone = zoneFor(t);
        const start = instant(date, t.from, zone),
          end = instant(date, t.to!, zone);
        if (+new Date(end) <= +new Date(start)) {
          uncertainties.push('Time range is reversed or crosses midnight.');
          continue;
        }
        // Read the clause around this range: "Monday 10am-1pm doesn't work, but 2-4pm does".
        const clause = scan
          .slice(
            Math.max(seg.start, scan.lastIndexOf(',', t.index) + 1),
            Math.min(seg.end, t.end + 40),
          )
          .split(/\bbut\b|;/i)[0];
        const kind = UNAVAILABLE.test(clause)
          ? 'unavailable'
          : /already|existing|scheduled|booked/i.test(sentence)
            ? 'existingMeeting'
            : 'availability';
        if (kind === 'existingMeeting')
          uncertainties.push(
            'Existing meeting details require verification; this interval will not create a meeting.',
          );
        addWindow({ start, end, kind, evidence: sentence, source: 'email' });
      } else {
        // Open-ended bounds: "nothing before 1pm", "not available after 3pm ET".
        const lead = scan.slice(Math.max(seg.start, t.index - 40), t.index);
        const bound = /\b(?:before|until|till|til|prior to|up to)\s*~?\s*$/i.test(lead)
          ? 'before'
          : /\b(?:after|past)\s*~?\s*$/i.test(lead)
            ? 'after'
            : null;
        if (!bound) continue;
        const clause = scan.slice(Math.max(seg.start, scan.lastIndexOf(',', t.index) + 1), t.end);
        const date = dateOf(t);
        if (!date) continue;
        evidence.push(sentence);
        if (NEGATIVE.test(clause) || UNAVAILABLE.test(clause)) {
          const zone = zoneFor(t);
          const at = instant(date, t.from, zone);
          const edge = (hhmm: string) => instant(date, hhmm, conference?.timezone || zone);
          addWindow({
            start: bound === 'before' ? edge('00:00') : at,
            end: bound === 'before' ? at : edge('23:59'),
            kind: 'unavailable',
            evidence: sentence,
            source: 'email',
          });
        } else {
          // "only up til 11:30": an open-ended offer has no exact window; ask for one.
          const quote = text
            .slice(Math.max(seg.start, scan.lastIndexOf(',', t.index) + 1), seg.end)
            .trim();
          if (!vague.some((v) => v.includes(quote) || quote.includes(v))) {
            vague.push(quote);
            uncertainties.push(`Explicit time needed: “${quote}”`);
          }
        }
      }
    }
  } else {
    // A meeting operation: one target time (the new/requested slot) and maybe a reference time
    // (the existing meeting the email talks about).
    let target: TimeTok | undefined;
    let reference: TimeTok | undefined;
    const singles: TimeTok[] = [];
    for (const t of usable) {
      // "from 1pm to 2:30pm" in a reschedule is a move, not a window.
      if (t.kind === 'range' && op === 'reschedule' && t.connector === 'to') {
        const [a, b] = t.raw.split(/\s+to\s+/i);
        singles.push({ ...t, kind: 'single', to: undefined, raw: a });
        singles.push({
          ...t,
          kind: 'single',
          from: t.to!,
          to: undefined,
          index: t.index + t.raw.length - b.length,
          raw: b,
        });
      } else singles.push(t);
    }
    // A time in a negative clause ("couldn't make the Tuesday 1pm slot") is never the target.
    const negativeAt = (t: TimeTok) => {
      const seg = segOf(t.index);
      const from = Math.max(
        seg.start,
        ...[',', ' - ', '. ', '? ', '(', ')'].map((c) => scan.lastIndexOf(c, t.index - 1) + c.length),
      );
      return /\b(?:couldn'?t|can'?t|cannot|not|still goes|already|no longer)\b/i.test(scan.slice(from, t.index));
    };
    const candidates =
      op === 'request' || op === 'confirm'
        ? [...singles.filter((t) => t.kind === 'range' && !negativeAt(t)), ...singles.filter((t) => !negativeAt(t))]
        : singles;
    for (const t of candidates) {
      const seg = segOf(t.index);
      const lead = scan.slice(Math.max(seg.start, t.index - 45), t.index);
      if (!target && (op !== 'reschedule' || TO_BEFORE.test(lead) || PROPOSE_BEFORE.test(lead)))
        target = t;
    }
    if (op === 'cancel' || op === 'update') [target, reference] = [undefined, singles[0]];
    else if (op === 'reschedule') {
      // A window ("to 3:00-3:30 PM") is always the new slot; else the last of two times.
      if (!target) target = singles.find((t) => t.kind === 'range');
      if (!target && singles.length >= 2) target = singles.at(-1);
      reference =
        singles.filter((t) => t !== target && t.index < (target?.index ?? Infinity)).at(-1) ||
        singles.find((t) => t !== target);
    }
    if (reference) {
      const date = dateOf(reference);
      if (date && reference.from) referenceTime = instant(date, reference.from, zoneFor(reference));
    }
    if (target) {
      const date = dateOf(target);
      const sentence = sentenceText(target);
      evidence.push(sentence);
      if (date) {
        const zone = zoneFor(target);
        const start = instant(date, target.from, zone);
        const end =
          target.kind === 'range' && target.to
            ? instant(date, target.to, zone)
            : new Date(+new Date(start) + slotLength * 60000).toISOString();
        addWindow({ start, end, kind: 'availability', evidence: sentence, source: 'email' });
        const minutes = (+new Date(end) - +new Date(start)) / 60000;
        flexible =
          op === 'request' &&
          target.kind === 'range' &&
          (minutes > (durationMinutes || 60) || /\bany ?time\b/i.test(sentence));
      }
    }
    if (op === 'reschedule' && !target) uncertainties.push('The new time is not stated.');
    if ((op === 'request' || op === 'confirm') && !target)
      uncertainties.push('No exact meeting time is stated.');
    if (
      referenceTime === null &&
      reference === undefined &&
      (op === 'cancel' || op === 'reschedule') &&
      !investorId
    )
      uncertainties.push('The email does not say which meeting; pick it carefully.');
  }
  // Vague times ("Tuesday morning", "after lunch till ~4ish"): never turned into windows.
  for (const s of segs) {
    const piece = scan.slice(s.start, s.end);
    if (!VAGUE.test(piece)) continue;
    let at = 0;
    for (const clause of piece.split(/,|;|\s-\s|\bbut\b/i)) {
      const startAt = piece.indexOf(clause, at);
      at = startAt + clause.length;
      if (!VAGUE.test(clause) || !OFFER.test(clause)) continue;
      if (
        tokens.some(
          (t) => t.kind === 'range' && t.index >= s.start + startAt && t.index < s.start + at,
        )
      )
        continue;
      const quote = text.slice(s.start + startAt, s.start + at).trim();
      if (!quote || vague.some((v) => v.includes(quote) || quote.includes(v))) continue;
      vague.push(quote);
      const hasTarget = windows.some((w) => w.kind === 'availability');
      // With an exact proposed time, a vague phrase is context ("Tuesday morning, ideally 9:30").
      if (hasTarget && (ALTERNATIVE.test(clause) || op !== 'availability')) continue;
      uncertainties.push(`Explicit time needed: “${quote}”`);
    }
  }
  vague.sort((a, b) => text.indexOf(a) - text.indexOf(b));
  if (
    category === 'General Conference Inquiry' &&
    windows.some((w) => w.kind !== 'existingMeeting')
  ) {
    category = 'Issuer Availability Update';
    operation = 'add';
  }
  if (category !== 'Unrelated Email') {
    if (!conference) uncertainties.unshift('Conference association is missing or ambiguous.');
    if (!issuerId) uncertainties.unshift('Issuer association is missing or ambiguous.');
  }
  if (
    category === 'Issuer Availability Update' &&
    !windows.some((w) => w.kind === 'availability' || w.kind === 'unavailable')
  )
    uncertainties.push('No explicit availability window could be extracted.');
  if (['confirm', 'cancel', 'reschedule'].includes(operation))
    uncertainties.push(
      'Select and verify the existing meeting or request before applying this change.',
    );
  const conditionMatch = CONDITIONAL.exec(askScan);
  const conditional = Boolean(conditionMatch) && category !== 'Issuer Availability Update';
  const condition = conditional
    ? (segs
        .map((s) => text.slice(s.start, s.end))
        .find((t) => CONDITIONAL.test(t)) || conditionMatch![0]
      ).trim()
    : '';
  if (conditional) uncertainties.push(`Conditional: “${condition}” — confirm the condition holds.`);
  const tentative = /\b(tentative|tentatively|may|might|possibly|pencil)\b/i.test(askScan);
  if (tentative)
    uncertainties.push('Tentative language detected; obtain explicit consent before confirmation.');

  const missing: MissingFact[] = [];
  if (category !== 'Unrelated Email') {
    if (!conference) missing.push('conference');
    if (!issuerId) missing.push('issuer');
    if (
      !investorId &&
      [
        'Reschedule Request',
        'Meeting Cancellation',
        'Meeting Confirmation',
        'New Meeting Request',
        'Meeting Update',
      ].includes(category)
    )
      missing.push('investor');
    if (
      ['Reschedule Request', 'New Meeting Request', 'Meeting Confirmation'].includes(category) &&
      !windows.some((w) => w.kind === 'availability')
    )
      missing.push('time');
    if (uncertainties.some((u) => u.startsWith('Explicit time needed'))) missing.push('exactTime');
    if (tentative) missing.push('finalConsent');
  }
  if (!evidence.length)
    evidence.push(
      ...segs
        .map((s) => text.slice(s.start, s.end))
        .filter(Boolean)
        .slice(0, 2),
    );
  const e = extractionSchema.parse({
    category,
    conferenceId: conference?.id || null,
    issuerId,
    investorId,
    operation,
    tentative,
    windows,
    uncertainties: [...new Set(uncertainties)],
    evidence: [...new Set(evidence)],
    needsReview: category !== 'Unrelated Email',
    meetingId: null,
    referenceTime,
    attendees: ['New Meeting Request', 'Meeting Confirmation', 'Meeting Update'].includes(category)
      ? info.attendees
      : null,
    durationMinutes,
    missing,
    vague,
    conditional,
    condition,
    flexible,
  });
  const names = {
    issuer: (id: string | null) => ctx.issuers.find((i) => i.id === id)?.name || 'Unassociated',
    investor: (id: string | null) => ctx.investors.find((i) => i.id === id)?.name || '—',
  };
  e.summary = askSummary(e, names, conference?.timezone);
  return e;
}

function emailInfo(body: string, subject: string, ctx: Context, hints: Hints): EmailInfo {
  const prepared = prepare(body);
  const combined = `${subject}\n${prepared.scan}`;
  const named = (items: { id: string; name: string }[]) => {
    const ids = [...new Set(mentions(combined, items).map((m) => m.id))];
    return ids.length === 1 ? ids[0] : null;
  };
  const namedConference =
    hints.conferenceId ||
    named(ctx.conferences) ||
    named(ctx.conferences.map((c) => ({ ...c, name: c.name.replace(/\s+\d{4}$/, '') })));
  const conferenceId = namedConference || hints.defaultConferenceId || null;
  const num = (x: string) => (/^\d+$/.test(x) ? +x : WORD_NUMBERS[x.toLowerCase()] || 0);
  const counts = [
    ...prepared.scan.matchAll(
      /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:of us|attendees|people|ppl|pax|persons|analysts|from our side|in total)\b/gi,
    ),
    ...prepared.scan.matchAll(/\bparty of (\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi),
    ...prepared.scan.matchAll(/\b(\d{1,2})\s+PMs\b/g),
  ]
    .map((m) => num(m[1]))
    .filter((x) => x > 0);
  return {
    prepared,
    ctx,
    hints,
    issuerMentions: mentions(prepared.scan, ctx.issuers),
    investorMentions: mentions(prepared.scan, ctx.investors),
    conference: ctx.conferences.find((c) => c.id === conferenceId),
    conferenceNamed: Boolean(namedConference),
    attendees: counts.length ? Math.max(...counts) : null,
    combined,
  };
}

/** Conference and companies an email names (used to pick a default event before parsing). */
export function namedContext(body: string, subject: string, ctx: Context) {
  const info = emailInfo(body, subject, ctx, {});
  return {
    conferenceId: info.conferenceNamed ? info.conference?.id || null : null,
    issuerIds: [...new Set(info.issuerMentions.map((m) => m.id))],
    investorIds: [
      ...new Set(
        info.investorMentions
          .filter((m) => !info.issuerMentions.some((i) => m.index < i.end && m.end > i.index))
          .map((m) => m.id),
      ),
    ],
  };
}

/** Legacy single-ask reading of the whole email (used by older callers and tests). */
export function mockExtract(
  body: string,
  subject: string,
  ctx: Context,
  hints?: Hints,
): Extraction {
  const info = emailInfo(body, subject, ctx, hints || {});
  const { scan } = info.prepared;
  const segs = sentenceSegs(scan, 0, scan.length);
  // The first sentence that asks for something decides; narrated verbs elsewhere do not.
  const op = segs.map((x) => classify(scan.slice(x.start, x.end))).find((o) => o && o !== 'nochange') ?? null;
  return parseAsk(
    { segs, op },
    info,
    op === 'nochange' ? null : op,
  );
}

/** Split an email into its asks: one schedule operation each. */
export function mockExtractAsks(
  body: string,
  subject: string,
  ctx: Context,
  hints?: Hints,
): { asks: Extraction[]; whole?: boolean } {
  const info = emailInfo(body, subject, ctx, hints || {});
  const { scan } = info.prepared;
  const groups: Group[] = [];
  const entityIds = (segs: Seg[]) => ({
    issuers: new Set(within(info.issuerMentions, segs).map((m) => m.id)),
    investors: new Set(within(info.investorMentions, segs).map((m) => m.id)),
  });
  const newCounterpart = (g: Group, s: Seg) => {
    const a = entityIds(g.segs),
      b = entityIds([s]);
    return (
      (a.issuers.size > 0 && [...b.issuers].some((x) => !a.issuers.has(x))) ||
      (a.investors.size > 0 && [...b.investors].some((x) => !a.investors.has(x)))
    );
  };
  const hasWhen = (s: Seg) =>
    timeTokens(scan.slice(s.start, s.end)).length > 0 ||
    dayTokens(scan.slice(s.start, s.end), '2000').length > 0;
  for (const s of segment(scan)) {
    const op = classify(scan.slice(s.start, s.end));
    if (op === 'nochange') continue;
    const last = groups.at(-1);
    if (s.item) {
      if (op || hasWhen(s)) groups.push({ segs: [s], op });
      continue;
    }
    const open = last && !last.segs.some((x) => x.item) ? last : undefined;
    if (op) {
      const piece = scan.slice(s.start, s.end);
      const separate =
        /^\W*(?:separately|also|additionally|on another note|new:|p\.?s\.?)\b/i.test(piece) ||
        (op === 'availability' && timeTokens(piece).some((t) => t.kind === 'range'));
      const merge =
        open &&
        !separate &&
        !newCounterpart(open, s) &&
        (op === open.op ||
          (op === 'availability' && COUNTERPART_OPS.includes(open.op)) ||
          open.op === null);
      if (merge) {
        open.segs.push(s);
        if (open.op === null) open.op = op;
      } else groups.push({ segs: [s], op });
    } else if (open && hasWhen(s)) open.segs.push(s);
  }
  // No sentence asks for anything: read the email as one item (usually a question or update).
  if (!groups.length) return { asks: [mockExtract(body, subject, info.ctx, info.hints)], whole: true };
  // "cancel ALL our Tuesday meetings (Rocket Mortgage 10am, Ford Credit 1pm)": one ask per company.
  const split: Group[] = [];
  for (const g of groups) {
    const list = g.op === 'cancel' || g.op === 'request' ? within(info.issuerMentions, g.segs) : [];
    const ids = [...new Set(list.map((m) => m.id))];
    if (g.segs.length !== 1 || ids.length < 2 || info.hints.issuerId) {
      split.push(g);
      continue;
    }
    const s = g.segs[0];
    const firsts = ids
      .map((id) => list.find((m) => m.id === id)!)
      .sort((a, b) => a.index - b.index);
    const prefix = { start: s.start, end: firsts[0].index, item: s.item };
    firsts.forEach((m, i) => {
      const piece = {
        start: m.index,
        end: i + 1 < firsts.length ? firsts[i + 1].index : s.end,
        item: s.item,
      };
      split.push({ segs: prefix.end > prefix.start ? [prefix, piece] : [piece], op: g.op });
    });
  }
  let asks = split.map((g) => parseAsk(g, info));
  // An availability remark with no exact time next to real asks ("…so the 10am won't work. Can we
  // move it to…") is context for those asks, not an ask of its own.
  const real = asks.filter((a) => a.category !== 'Issuer Availability Update' || a.windows.length);
  if (real.length && real.length < asks.length) {
    const extra = asks.filter((a) => !real.includes(a)).flatMap((a) => a.vague);
    real[0].vague = [...new Set([...real[0].vague, ...extra])];
    asks = real;
  }
  return { asks };
}
