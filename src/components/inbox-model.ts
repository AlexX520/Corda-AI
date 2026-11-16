import type { AppState } from '@/lib/types';
import type { Extraction } from '@/lib/extraction-schema';
import { actionKind, kindOrder, type KindId } from './queue-model';
import { fmt } from './shared';

type Action = AppState['actions'][number];
type Email = AppState['emails'][number];
type Request = AppState['requests'][number];

const DONE = ['Approved', 'Rejected', 'Acknowledged', 'Resolved', 'Expired'];
export type Tone = 'red' | 'amber' | 'indigo' | 'grey';
/** Alex's four schedule-change types, plus the urgent ones that sit above them. */
export type ItemKind = KindId | 'phishing';
export const itemKindLabel: Record<ItemKind, string> = {
  escalation: 'Escalation',
  phishing: 'Check sender',
  new: 'New request',
  reschedule: 'Reschedule',
  availability: 'Availability',
  cancel: 'Cancel',
  preference: 'Preferences',
  other: 'Other',
};
export const urgentKind = (k: ItemKind) => k === 'escalation' || k === 'phishing';
export type SortMode = 'meeting' | 'received' | 'type';
/** One format for meeting times everywhere on the to-do list: "Mon Dec 7, 11:30 AM". */
export const WHEN = 'EEE MMM d, h:mm a';
export const meetingWhen = (iso: string, zone: string) => fmt(iso, zone, WHEN);
/** Email times are always relative and labelled "Received …", so they never look like a meeting time. */
export function receivedAgo(iso: string, now: string, zone: string) {
  const mins = Math.round((+new Date(now) - +new Date(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60 && fmt(iso, zone, 'yyyy-MM-dd') === fmt(now, zone, 'yyyy-MM-dd')) return `${Math.round(mins / 60)} h ago`;
  if (mins < 48 * 60) return 'yesterday';
  return fmt(iso, zone, 'MMM d');
}

/** One line of the inbox: an email (with all its open asks), a sales request, or another task. */
export type InboxItem = {
  id: string;
  kind: 'email' | 'request' | 'other';
  email?: Email;
  request?: Request;
  actions: Action[];
  who: string;
  /** Short line for the list. */
  what: string;
  /** One-sentence headline for the detail pane and Today. */
  headline: string;
  /** Second line on Today. */
  sub: string;
  cta: string;
  tone: Tone;
  at: string;
  /** Which of the four change types (the main one when an email has several). */
  type: ItemKind;
  /** How many more changes of other types the same email holds. */
  more: number;
  /** When the meeting it is about takes place (for "sort by meeting time"). */
  meetingAt: string | null;
  /** What meetingAt is: the booked meeting, the time asked for, or offered availability. */
  whenLabel: 'Meeting' | 'Asked for' | 'Available' | 'Not available';
  /** The time(s) to show next to whenLabel, one format everywhere ("Mon Dec 7, 10:00 → 11:30 AM"). */
  whenText: string;
  mine: boolean;
  /** The one person who owns this item (assigned, else the issuer's coverage banker). */
  owner: string | null;
};

const x = (p: { extraction: unknown }) => p.extraction as unknown as Extraction;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

type Party = { contactEmail?: string; domain?: string };
const domain = (x: string | null | undefined) => (x || '').split('@').pop()?.trim().toLowerCase() || '';
/** The registered company the email was written by (by sender domain), if any. */
export function senderCompany(e: Email, data: AppState): string | null {
  const d = domain(e.originalSender || e.sender);
  if (!d) return null;
  return (
    data.investors.find((i) => (i as Party).domain === d)?.name ||
    data.issuers.find((i) => domain((i as Party).contactEmail) === d)?.name ||
    null
  );
}

export function senderName(e: Email) {
  const raw = e.originalSenderName || e.originalSender || e.sender;
  return raw.includes('@') ? raw.split('@')[0].replace(/[._]/g, ' ') : raw;
}

/** Why an ask cannot simply be applied, in a few words (null = ready). */
export function askBlocker(p: Email['proposals'][number], e: Email): string | null {
  const a = x(p);
  if (p.status === 'Clarification requested') return 'Waiting on a reply';
  if (p.status === 'Waiting on sales') return 'Waiting on sales';
  if (!e.conferenceId) return 'Which event?';
  if (a?.conditional) return 'Depends on a condition';
  if (a?.missing?.includes('exactTime') || a?.missing?.includes('time')) return 'Needs a time';
  if (a?.missing?.includes('investor')) return 'Which investor?';
  if (a?.missing?.includes('issuer')) return 'Which issuer?';
  if (a?.missing?.includes('finalConsent')) return 'Tentative';
  return null;
}

export function inboxItems(data: AppState, actions: Action[], zone: string): InboxItem[] {
  const me = data.user.id;
  const issuerName = (id: string | null) => data.issuers.find((i) => i.id === id)?.name || null;
  const investorName = (id: string | null) => data.investors.find((i) => i.id === id)?.name || null;
  // One owner per item: whoever it is assigned to, else the banker who owns the issuer.
  const ownerOf = (a: Action) => a.assignedTo || data.issuers.find((i) => i.id === a.issuerId)?.ownerId || null;
  const owns = (a: Action) => ownerOf(a) === me;
  const items: InboxItem[] = [];
  const meetingStart = (id: string | null | undefined) => (id ? data.meetings.find((m) => m.id === id)?.start || null : null);
  const earliest = (xs: (string | null | undefined)[]) => (xs.filter(Boolean) as string[]).sort()[0] || null;
  const byEmail = new Map<string, Action[]>();
  for (const a of actions) {
    if (a.emailId && data.emails.some((e) => e.id === a.emailId)) byEmail.set(a.emailId, [...(byEmail.get(a.emailId) || []), a]);
    else if (a.requestId && data.requests.some((r) => r.id === a.requestId)) {
      const r = data.requests.find((q) => q.id === a.requestId)!;
      const investor = investorName(r.investorId) || 'An investor';
      const issuer = issuerName(r.issuerId) || 'an issuer';
      items.push({
        id: `request:${r.id}`,
        kind: 'request',
        request: r,
        actions: [a],
        who: investor,
        what: `Wants a meeting with ${issuer}`,
        headline: `${investor} wants a meeting with ${issuer}`,
        sub: `From ${data.users.find((u) => u.id === r.salespersonId)?.name || 'sales'}`,
        cta: 'Review',
        tone: a.priority === 'Urgent' ? 'amber' : 'indigo',
        at: a.createdAt,
        type: actionKind(a, data).id,
        more: 0,
        meetingAt: r.start,
        whenLabel: 'Asked for',
        whenText: fmt(r.start, zone, WHEN),
        mine: owns(a),
        owner: ownerOf(a),
      });
    } else
      items.push({
        id: `action:${a.id}`,
        kind: 'other',
        actions: [a],
        who: issuerName(a.issuerId) || actionKind(a, data).label,
        what: a.title,
        headline: a.title,
        sub: actionKind(a, data).label,
        cta: 'Open',
        tone: 'indigo',
        at: a.createdAt,
        type: actionKind(a, data).id,
        more: 0,
        meetingAt: meetingStart((a as { meetingId?: string | null }).meetingId),
        whenLabel: 'Meeting',
        whenText: meetingStart((a as { meetingId?: string | null }).meetingId) ? fmt(meetingStart((a as { meetingId?: string | null }).meetingId)!, zone, WHEN) : '',
        mine: owns(a),
        owner: ownerOf(a),
      });
  }
  for (const [emailId, list] of byEmail) {
    const e = data.emails.find((q) => q.id === emailId)!;
    const open = e.proposals.filter((p) => !DONE.includes(p.status) || (p.status === 'Acknowledged' && list.some((a) => a.proposalId === p.id)));
    const changes = open.filter((p) => x(p)?.category !== 'Escalation / complaint');
    const escalation = e.escalation ? e.proposals.find((p) => x(p)?.category === 'Escalation / complaint') : undefined;
    const company = senderCompany(e, data) || issuerName(e.issuerId) || investorName(e.investorId);
    const suspicious = e.suspicious || e.senderStatus === 'unverified';
    const colleague = data.users.find((u) => u.email.toLowerCase() === (e.originalSender || e.sender).toLowerCase())?.name;
    const who = suspicious ? 'Unverified sender' : company || colleague || senderName(e);
    const blockers = changes.map((p) => askBlocker(p, e)).filter(Boolean) as string[];
    const first = changes[0] || open[0];
    // Short wording: "move Wellington to Sun 11:30 AM" (the sender's own name is in the row already).
    const short = (p: (typeof changes)[number], withTime = true) => {
      const a = x(p);
      if (!a) return p.summary;
      if (a.preferences?.length) return p.summary.replace(/^Coverage preferences:\s*/i, '');
      const other = (a.issuerId && senderCompany(e, data) === issuerName(a.issuerId) ? investorName(a.investorId) : issuerName(a.issuerId) || investorName(a.investorId)) || '';
      const w = a.windows?.find((v) => v.kind === 'availability');
      const at = w && withTime ? fmt(w.start, zone, WHEN) : '';
      const span = w && withTime ? `${fmt(w.start, zone, 'EEE MMM d, h:mm')}–${fmt(w.end, zone, 'h:mm a')}` : '';
      if (a.operation === 'reschedule') return `move ${other}${at ? ` to ${at}` : ''}`;
      if (a.operation === 'cancel') return `cancel ${other || 'a meeting'}`;
      if (a.operation === 'confirm') return `confirm ${other}${at ? ` at ${at}` : ''}`;
      if (a.category === 'New Meeting Request') return `add ${other}${a.flexible && span ? ` (${span})` : at ? ` at ${at}` : ''}`;
      if (a.category === 'Issuer Availability Update') return a.operation === 'remove' ? `not available${span ? ` ${span}` : ''}` : `available${span ? ` ${span}` : ''}`;
      if (a.operation === 'update') return `update ${other}${a.attendees ? ` · ${a.attendees} people` : ''}`;
      return p.summary;
    };
    const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
    let what: string, headline: string, sub: string, cta: string, tone: Tone;
    if (suspicious) {
      tone = 'amber';
      what = 'Possible phishing';
      headline = 'Possible phishing — do not act on it';
      sub = `Look-alike sender: ${(e.originalSender || e.sender).split('@').pop()}`;
      cta = 'Check';
    } else if (escalation) {
      tone = 'red';
      const said = (escalation.summary || '').replace(new RegExp(`^${who.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:·-]\\s*`, 'i'), '');
      // The time is on its own line, so the words drop it ("Hold Santander × Apollo, do not move again").
      const plain = said.replace(/\s+(?:on\s+)?(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i, '');
      what = plain ? cap(plain) : 'Client escalation';
      headline = said ? `${who}: ${said}` : `${who} escalation`;
      sub = 'Client escalation';
      cta = 'Review';
    } else if (changes.length > 1) {
      tone = blockers.length ? 'amber' : 'indigo';
      what = plural(changes.length, 'change');
      headline = `${who} sent ${plural(changes.length, 'change')}`;
      sub = cap(changes.slice(0, 3).map((p) => short(p)).join(', ')) + (changes.length > 3 ? ', …' : '');
      cta = `Review ${plural(changes.length, 'change')}`;
    } else {
      tone = blockers.length ? 'amber' : 'indigo';
      what = first ? cap(short(first, false)) : e.subject;
      headline = first ? `${who}: ${short(first)}` : e.subject;
      sub = blockers[0] || (e.forwardedBy ? `Forwarded by ${senderName({ ...e, originalSender: null, originalSenderName: null } as Email)}` : '');
      cta = blockers.length ? 'Resolve' : 'Review';
    }
    // Main type: the first change's type; other types in the same email count as "+N".
    // In the order the email lists its changes, so "Move X, cancel Y" reads as a Reschedule.
    const kinds = [
      ...changes.map((p) => list.find((a) => a.proposalId === p.id)).filter(Boolean),
      ...list.filter((a) => !a.proposalId),
    ]
      .map((a) => actionKind(a!, data).id)
      .filter((k) => k !== 'escalation');
    const kind: ItemKind = suspicious ? 'phishing' : escalation ? 'escalation' : kinds[0] || 'other';
    const others = new Set(kinds.filter((k) => k !== kind));
    // The booked meeting this is about when there is one (a reschedule shows its current time and
    // says the new one in words); otherwise the time asked for, or the availability offered.
    // The booked meeting an ask is about: matched by Corda, else the one meeting of that pair.
    const bookedOf = (a: Extraction | undefined) => {
      if (!a) return null;
      if (a.meetingId) return meetingStart(a.meetingId);
      if (!a.issuerId || !a.investorId || !['reschedule', 'cancel', 'update', 'confirm', 'escalate'].includes(a.operation)) return null;
      const pair = data.meetings.filter((m) => m.issuerId === a.issuerId && m.investorId === a.investorId && m.status === 'Confirmed' && (!e.conferenceId || m.conferenceId === e.conferenceId));
      const byRef = a.referenceTime ? pair.filter((m) => +new Date(m.start) === +new Date(a.referenceTime!)) : [];
      return (byRef.length === 1 ? byRef[0] : pair.length === 1 ? pair[0] : null)?.start || null;
    };
    const main = escalation && !changes.length ? escalation : first;
    const a0 = main ? x(main) : undefined;
    const booked = bookedOf(a0) || earliest(open.map((p) => bookedOf(x(p))));
    const win = a0?.windows?.find((w) => w.kind !== 'existingMeeting');
    const asked = win?.start || earliest(open.flatMap((p) => (x(p)?.windows || []).filter((w) => w.kind !== 'existingMeeting').map((w) => w.start)));
    const meetingAt = booked || asked;
    const sameDay = (p: string, q: string) => fmt(p, zone, 'yyyy-MM-dd') === fmt(q, zone, 'yyyy-MM-dd');
    let whenLabel: InboxItem['whenLabel'] = booked ? 'Meeting' : kind === 'availability' ? 'Available' : 'Asked for';
    let whenText = meetingAt ? fmt(meetingAt, zone, WHEN) : '';
    if (changes.length <= 1 && a0 && !suspicious) {
      if (a0.operation === 'reschedule' && booked && win)
        whenText = `${fmt(booked, zone, WHEN)} → ${sameDay(booked, win.start) ? fmt(win.start, zone, 'h:mm a') : fmt(win.start, zone, WHEN)}`;
      else if (kind === 'availability' && win) {
        whenLabel = a0.operation === 'remove' || win.kind === 'unavailable' ? 'Not available' : 'Available';
        whenText = `${fmt(win.start, zone, 'EEE MMM d, h:mm')}–${fmt(win.end, zone, 'h:mm a')}`;
      } else if (!booked && win && a0.flexible) whenText = `${fmt(win.start, zone, 'EEE MMM d, h:mm')}–${fmt(win.end, zone, 'h:mm a')}`;
    }
    items.push({
      id: `email:${e.id}`,
      kind: 'email',
      email: e,
      actions: list,
      who,
      what,
      headline,
      sub,
      cta,
      tone,
      at: e.receivedAt,
      type: kind,
      more: suspicious || escalation ? 0 : Math.max(others.size, changes.length - 1),
      meetingAt,
      whenLabel,
      whenText,
      mine: list.some(owns),
      owner: ownerOf(list[0]),
    });
  }
  return sortItems(items, 'meeting');
}

/**
 * Urgent items (escalations, look-alike senders) always come first; the rest follow the chosen
 * order: soonest meeting first (Alex's default), newest email first, or grouped by type.
 */
export function sortItems(items: InboxItem[], mode: SortMode) {
  const urgent = (i: InboxItem) => (urgentKind(i.type) || i.tone === 'red' ? 0 : 1);
  const far = '9999';
  return [...items].sort((a, b) => {
    const u = urgent(a) - urgent(b);
    if (u) return u;
    if (mode === 'received') return b.at.localeCompare(a.at);
    if (mode === 'type') {
      const d = kindOrder.indexOf(a.type as KindId) - kindOrder.indexOf(b.type as KindId);
      if (d) return d;
    }
    return (a.meetingAt || far).localeCompare(b.meetingAt || far) || b.at.localeCompare(a.at);
  });
}

/** "2:04 PM" for today, "Thu" for other days. */
export function shortWhen(iso: string, now: string, zone: string) {
  return fmt(iso, zone, 'yyyy-MM-dd') === fmt(now, zone, 'yyyy-MM-dd') ? fmt(iso, zone, 'h:mm a') : fmt(iso, zone, 'EEE');
}
