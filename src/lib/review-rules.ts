/**
 * Pure review rules shared by the server and the browser: plain-language summaries of an ask,
 * which existing meeting/request an ask may refer to (and why), duplicate warnings and how the
 * status of an email follows from the status of its asks.
 */
import { formatInTimeZone } from 'date-fns-tz';
import type { Extraction } from './extraction-schema';

type When = string | Date;
const iso = (d: When) => (typeof d === 'string' ? d : d.toISOString());
const local = (d: When, zone: string, pattern: string) => formatInTimeZone(d, zone, pattern);

/** "Mon 2:00 PM", or "Mon before 1:00 PM" / "Tue after 3:00 PM" for whole-morning/afternoon blocks. */
export function windowLabel(w: { start: When; end: When }, zone: string, withEnd = true) {
  const s = local(w.start, zone, 'HH:mm'),
    e = local(w.end, zone, 'HH:mm');
  const day = local(w.start, zone, 'EEE');
  if (s === '00:00') return `${day} before ${local(w.end, zone, 'h:mm a')}`;
  if (e === '23:59') return `${day} after ${local(w.start, zone, 'h:mm a')}`;
  return withEnd
    ? `${day} ${local(w.start, zone, 'h:mm a')}–${local(w.end, zone, 'h:mm a')}`
    : `${day} ${local(w.start, zone, 'h:mm a')}`;
}

export type Names = {
  issuer: (id: string | null) => string;
  investor: (id: string | null) => string;
};

/** One line a banker can read at a glance: "Move BlackRock to Tue 2:00 PM". */
export function askSummary(e: Extraction, n: Names, zone = 'America/New_York') {
  const investor = e.investorId ? n.investor(e.investorId) : '';
  const issuer = e.issuerId ? n.issuer(e.issuerId) : '';
  const who = investor && issuer ? `${issuer} × ${investor}` : investor || issuer || 'meeting';
  const offered = e.windows.filter((w) => w.kind === 'availability');
  const blocked = e.windows.filter((w) => w.kind === 'unavailable');
  const at = offered[0] ? windowLabel(offered[0], zone, false) : '';
  const was = e.referenceTime ? local(e.referenceTime, zone, 'EEE h:mm a') : '';
  switch (e.category) {
    case 'Reschedule Request':
      return `Move ${who}${was ? ` from ${was}` : ''}${at ? ` to ${at}` : ' (new time not stated)'}${e.conditional ? ' (conditional)' : ''}`;
    case 'Meeting Cancellation':
      return `Cancel ${who}${was ? ` (${was})` : ''}`;
    case 'New Meeting Request': {
      const len = offered[0]
        ? Math.round((+new Date(offered[0].end) - +new Date(offered[0].start)) / 60000)
        : null;
      const parts = [`Add ${who}`];
      if (at && e.flexible)
        parts.push(`any time ${windowLabel(offered[0], zone)} (${e.durationMinutes || 30} min)`);
      else if (at) parts.push(`${at}${len ? `, ${len} min` : ''}`);
      else parts.push('time not stated');
      if (e.attendees) parts.push(`${e.attendees} attendees`);
      return parts.join(' · ');
    }
    case 'Meeting Confirmation':
      return `Confirm ${who}${at ? ` · ${at}` : ''}`;
    case 'Meeting Update':
      return `Update ${who}${e.attendees ? `: ${e.attendees} attendees` : ''}${e.conditional ? ' (conditional)' : ''}`;
    case 'Escalation / complaint':
      return `Escalation about ${[issuer, investor].filter(Boolean).join(' × ') || 'the schedule'}`;
    case 'Issuer Availability Update': {
      const bits: string[] = [];
      if (blocked.length)
        bits.push(`Not available ${blocked.map((w) => windowLabel(w, zone)).join(', ')}`);
      if (offered.length)
        bits.push(
          `${e.operation === 'remove' ? 'Remove' : e.operation === 'replace' ? 'Only' : 'Available'} ${offered
            .slice(0, 3)
            .map((w) => windowLabel(w, zone))
            .join(', ')}${offered.length > 3 ? ` +${offered.length - 3}` : ''}`,
        );
      if (!bits.length) bits.push('Availability without exact times');
      return bits.join(' · ');
    }
    case 'Unrelated Email':
      return 'Not about the conference';
    default:
      return blocked.length
        ? `Not available ${blocked.map((w) => windowLabel(w, zone)).join(', ')}`
        : 'Question — no schedule change';
  }
}

export type MeetingLike = {
  id: string;
  conferenceId: string;
  issuerId: string;
  investorId: string;
  start: When;
  end: When;
  status: string;
};
export type Candidate<T> = { item: T; reasons: string[]; timeMatches: boolean | null };
export type CandidateResult<T> = {
  candidates: Candidate<T>[];
  preselectId: string | null;
  /** Why the suggestion was (or was not) made. */
  why: string;
};

/**
 * Which existing meeting (or request) an ask refers to. A candidate is only pre-selected when the
 * issuer matches, the investor matches whenever the email names one, it is the only candidate,
 * its time agrees with the time the email mentions, and the sender is trusted.
 */
export function findCandidates<T extends MeetingLike>(
  ask: Pick<Extraction, 'conferenceId' | 'issuerId' | 'investorId' | 'referenceTime'> & { evidence?: string[]; summary?: string },
  items: T[],
  opts: { zone: string; trusted: boolean; open: (s: string) => boolean; n: Names; noun?: string; now?: Date },
): CandidateResult<T> {
  const noun = opts.noun || 'meeting';
  if (!ask.issuerId)
    return {
      candidates: [],
      preselectId: null,
      why: `Pick the issuer first; Corda only suggests a ${noun} of the same issuer.`,
    };
  const ref = ask.referenceTime ? +new Date(ask.referenceTime) : null;
  // Weekdays the email names for this ask ("drop the PIMCO lunch on Thursday").
  const said = (ask.evidence || []).join(' ').toLowerCase();
  const days = WEEKDAYS.filter((d) => new RegExp(`\\b${d}(day)?\\b`).test(said.replace(/(mon|tues|wednes|thurs|fri|satur|sun)day/g, (w) => w.slice(0, 3))));
  // "today's meeting", "tomorrow" name a day too.
  if (opts.now && /\b(today|today's|tonight|this morning|this afternoon)\b/.test(said)) days.push(local(opts.now, opts.zone, 'EEE').toLowerCase().slice(0, 3));
  if (opts.now && /\b(tomorrow|tmrw|tmw)\b/.test(said)) days.push(local(new Date(+opts.now + 86400000), opts.zone, 'EEE').toLowerCase().slice(0, 3));
  const nowMs = +(opts.now || new Date(0));
  const pool = items.filter(
    (m) =>
      // A meeting that already took place is never the one an email asks to change.
      +new Date(m.end) > nowMs &&
      opts.open(m.status) &&
      m.issuerId === ask.issuerId &&
      (!ask.conferenceId || m.conferenceId === ask.conferenceId) &&
      (!ask.investorId || m.investorId === ask.investorId),
  );
  const candidates = pool
    .map((m) => {
      const reasons = [`Same issuer (${opts.n.issuer(m.issuerId)})`];
      reasons.push(
        ask.investorId
          ? `Same investor (${opts.n.investor(m.investorId)})`
          : 'Investor not named in the email',
      );
      const weekday = local(m.start, opts.zone, 'EEE').toLowerCase().slice(0, 3);
      const timeMatches =
        ref !== null ? +new Date(m.start) === ref : days.length ? days.includes(weekday) || null : null;
      if (ref === null && days.length && !days.includes(weekday))
        return { item: m, reasons: [...reasons, `Email says ${days.map((d) => d[0].toUpperCase() + d.slice(1)).join('/')}; this ${noun} is ${local(m.start, opts.zone, 'EEE h:mm a')}`], timeMatches: false };
      if (timeMatches === true)
        reasons.push(`Time matches the email (${local(m.start, opts.zone, 'EEE h:mm a')})`);
      if (timeMatches === false)
        reasons.push(
          `Email says ${local(ask.referenceTime!, opts.zone, 'EEE h:mm a')}; this ${noun} is ${local(m.start, opts.zone, 'EEE h:mm a')}`,
        );
      return { item: m, reasons, timeMatches };
    })
    .sort(
      (a, b) =>
        Number(b.timeMatches === true) - Number(a.timeMatches === true) ||
        iso(a.item.start).localeCompare(iso(b.item.start)),
    );
  if (!candidates.length)
    return {
      candidates,
      preselectId: null,
      why: `No open ${noun} matches ${ask.investorId ? `${opts.n.issuer(ask.issuerId)} × ${opts.n.investor(ask.investorId)}` : opts.n.issuer(ask.issuerId)}.`,
    };
  const only = candidates.length === 1 ? candidates[0] : null;
  const timeOk = only?.timeMatches === false ? false : ref === null ? Boolean(ask.investorId) : only?.timeMatches === true;
  if (!opts.trusted)
    return {
      candidates,
      preselectId: null,
      why: 'Sender not verified — pick the ' + noun + ' yourself.',
    };
  if (only && timeOk)
    return {
      candidates,
      preselectId: only.item.id,
      why: `Suggested: ${only.reasons.join(' · ')}.`,
    };
  if (only)
    return {
      candidates,
      preselectId: null,
      why: ask.investorId
        ? `Check the time before picking: ${only.reasons.slice(2).join(' · ')}.`
        : `The email names no investor; confirm this is the right ${noun}.`,
    };
  return { candidates, preselectId: null, why: `${candidates.length} ${noun}s match — pick one.` };
}

export const isOpenMeeting = (s: string) => s === 'Confirmed';
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const isOpenRequest = (s: string) => !['Confirmed', 'Cancelled'].includes(s);

/** Confirmed meetings or open requests the same investor already has with the same issuer. */
export function duplicatesFor<M extends MeetingLike, R extends MeetingLike>(
  ask: Pick<Extraction, 'conferenceId' | 'issuerId' | 'investorId'>,
  meetings: M[],
  requests: R[],
) {
  if (!ask.issuerId || !ask.investorId) return [];
  const same = (m: MeetingLike) =>
    m.issuerId === ask.issuerId &&
    m.investorId === ask.investorId &&
    (!ask.conferenceId || m.conferenceId === ask.conferenceId);
  return [
    ...meetings
      .filter((m) => m.status === 'Confirmed' && same(m))
      .map((m) => ({ kind: 'meeting' as const, item: m })),
    ...requests
      .filter((r) => isOpenRequest(r.status) && same(r))
      .map((r) => ({ kind: 'request' as const, item: r })),
  ];
}

/** Statuses after which an ask needs nothing more from the reviewer. */
export const DONE_ASK = ['Approved', 'Rejected', 'Acknowledged', 'Resolved', 'Expired'];
export const DONE_EMAIL = ['Approved', 'Rejected', 'Acknowledged', 'Resolved', 'Ignored'];

/** An email is done only when every ask in it is done. */
export function rollupEmailStatus(askStatuses: string[]) {
  if (!askStatuses.length) return 'Ignored';
  if (askStatuses.every((s) => DONE_ASK.includes(s)))
    return new Set(askStatuses).size === 1 ? askStatuses[0] : 'Resolved';
  if (askStatuses.some((s) => s === 'Pending')) return 'Pending review';
  return 'Clarification requested';
}

/**
 * The salesperson who sent, forwarded or was copied on the email owns a request created from it;
 * otherwise the issuer's coverage banker. Never the banker who happens to approve it.
 */
export function requestOwner(
  email: { sender: string; cc: string[]; to: string[] },
  users: { id: string; email: string; role: string }[],
  fallbackId: string | null,
) {
  const sales = users.filter((u) => u.role === 'SALES');
  const find = (list: string[]) =>
    sales.find((u) => list.some((a) => a.trim().toLowerCase() === u.email.toLowerCase()));
  return (find([email.sender]) || find(email.cc) || find(email.to))?.id || fallbackId;
}

/**
 * Issuer availability for a day: "CFO free 9–11 and 2–4 Wed" means exactly those windows (narrow);
 * "can ALSO do 9–11" / "in addition" adds to what is already there (extend).
 */
export function availabilityMode(text: string): 'narrow' | 'extend' {
  return /\b(also|additionally|in addition|as well|another window|extra (?:slot|window|time)s?)\b/i.test(text) ? 'extend' : 'narrow';
}

/**
 * Sentences of the email that no ask covers: questions ("does the room have a screen?") and
 * requests the parser did not turn into an ask. Greetings, sign-offs and quoted text are skipped.
 */
export function unhandledSentences(content: string, evidence: string[]) {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9:]+/g, ' ').trim();
  const covered = evidence.map(norm).filter((x) => x.length > 6);
  const SKIP = /^(hi|hello|hey|dear|thanks|thank you|thx|best|regards|cheers|sorry|apologies|sent from|fyi|all)\b|^[A-Z][a-z]+ ?[A-Z]?[a-z]*$|\|/i;
  const sentences = content
    .split(/\n+/)
    .filter((l) => !l.trim().startsWith('>') && !/^(on .* wrote:|-----|from:|sent:|to:|subject:)/i.test(l.trim()))
    .flatMap((l) => l.split(/(?<=[.?!])\s+/))
    .map((x) => x.replace(/^\s*(?:\d+[.)]|[-•*])\s*/, '').trim())
    .filter((x) => x.length > 12 && !SKIP.test(x));
  return sentences
    .filter((x) => {
      const n = norm(x);
      return !covered.some((c) => n.includes(c) || c.includes(n) || overlap(n, c) > 0.6);
    })
    .map((text) => ({ text, question: /\?\s*$/.test(text) || /^(can|could|does|do|is|are|will|would|any chance)\b/i.test(text) }))
    .filter((x) => x.question || /\b(please|pls|need|can we|could we|confirm|add|move|cancel|room|screen|dial-in|headcount|people)\b/i.test(x.text));
}
function overlap(a: string, b: string) {
  const A = new Set(a.split(' ').filter((w) => w.length > 2));
  const B = new Set(b.split(' ').filter((w) => w.length > 2));
  if (!A.size) return 0;
  return [...A].filter((w) => B.has(w)).length / A.size;
}
