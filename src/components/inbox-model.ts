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
  other: 'Other',
};
export const urgentKind = (k: ItemKind) => k === 'escalation' || k === 'phishing';
export type SortMode = 'meeting' | 'received' | 'type';

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
        what: `Wants ${issuer} · ${fmt(r.start, zone, 'EEE h:mm a')}`,
        headline: `${investor} wants ${issuer}, ${fmt(r.start, zone, 'EEE h:mm a')}`,
        sub: `From ${data.users.find((u) => u.id === r.salespersonId)?.name || 'sales'}`,
        cta: 'Review',
        tone: a.priority === 'Urgent' ? 'amber' : 'indigo',
        at: a.createdAt,
        type: actionKind(a, data).id,
        more: 0,
        meetingAt: r.start,
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
    const who = suspicious ? 'Unverified sender' : company || senderName(e);
    const blockers = changes.map((p) => askBlocker(p, e)).filter(Boolean) as string[];
    const first = changes[0] || open[0];
    // Short wording: "move Wellington to Sun 11:30 AM" (the sender's own name is in the row already).
    const short = (p: (typeof changes)[number]) => {
      const a = x(p);
      if (!a) return p.summary;
      const other = (a.issuerId && senderCompany(e, data) === issuerName(a.issuerId) ? investorName(a.investorId) : issuerName(a.issuerId) || investorName(a.investorId)) || '';
      const w = a.windows?.find((v) => v.kind === 'availability');
      const at = w ? fmt(w.start, zone, 'EEE h:mm a') : '';
      const span = w ? `${fmt(w.start, zone, 'EEE h:mm')}–${fmt(w.end, zone, 'h:mm a')}` : '';
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
      what = escalation.summary || 'Client escalation';
      headline = escalation.summary || `${who} escalation`;
      sub = 'Client escalation';
      cta = 'Review';
    } else if (changes.length > 1) {
      tone = blockers.length ? 'amber' : 'indigo';
      what = plural(changes.length, 'change');
      headline = `${who} sent ${plural(changes.length, 'change')}`;
      sub = cap(changes.slice(0, 3).map(short).join(', ')) + (changes.length > 3 ? ', …' : '');
      cta = `Review ${plural(changes.length, 'change')}`;
    } else {
      tone = blockers.length ? 'amber' : 'indigo';
      what = first ? cap(short(first)) : e.subject;
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
    const meetingAt = earliest(
      open.flatMap((p) => {
        const a = x(p);
        return [...(a?.windows || []).map((w) => w.start), meetingStart(a?.meetingId)];
      }),
    );
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
