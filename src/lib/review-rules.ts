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
      return `Move ${who}${was ? ` from ${was}` : ''}${at ? ` to ${at}` : ' (new time not stated)'}`;
    case 'Meeting Cancellation':
      return `Cancel ${who}${was ? ` (${was})` : ''}`;
    case 'New Meeting Request': {
      const len = offered[0]
        ? Math.round((+new Date(offered[0].end) - +new Date(offered[0].start)) / 60000)
        : null;
      const parts = [`Add ${who}`];
      if (at) parts.push(`${at}${len ? `, ${len} min` : ''}`);
      else parts.push('time not stated');
      if (e.attendees) parts.push(`${e.attendees} attendees`);
      return parts.join(' · ');
    }
    case 'Meeting Confirmation':
      return `Confirm ${who}${at ? ` · ${at}` : ''}`;
    case 'Escalation / complaint':
      return `Escalation${issuer ? ` from ${issuer}` : ''}${investor ? ` about ${investor}` : ''}`;
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
  ask: Pick<Extraction, 'conferenceId' | 'issuerId' | 'investorId' | 'referenceTime'>,
  items: T[],
  opts: { zone: string; trusted: boolean; open: (s: string) => boolean; n: Names; noun?: string },
): CandidateResult<T> {
  const noun = opts.noun || 'meeting';
  if (!ask.issuerId)
    return {
      candidates: [],
      preselectId: null,
      why: `Pick the issuer first; Corda only suggests a ${noun} of the same issuer.`,
    };
  const ref = ask.referenceTime ? +new Date(ask.referenceTime) : null;
  const pool = items.filter(
    (m) =>
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
      const timeMatches = ref === null ? null : +new Date(m.start) === ref;
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
  const timeOk = ref === null ? Boolean(ask.investorId) : only?.timeMatches === true;
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
export const DONE_ASK = ['Approved', 'Rejected', 'Acknowledged', 'Resolved'];
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
