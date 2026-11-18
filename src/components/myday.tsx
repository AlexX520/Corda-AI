'use client';
import type React from 'react';
import type { AppState } from '@/lib/types';
import { Check } from 'lucide-react';
import { CordaMark } from './ui/corda-mark';
import { actionKind } from './queue-model';
import { inboxItems, itemKindLabel, urgentKind, type InboxItem, type ItemKind } from './inbox-model';
import { kindOrder } from './queue-model';
import { fmt, names, type Run } from './shared';

type Action = AppState['actions'][number];
type Meeting = AppState['meetings'][number];

/** My meetings on a conference day: confirmed seats plus seats proposed by an allocation run (pending). */
export function myMeetings(data: AppState, conferenceId: string, day: string, zone: string) {
  const me = data.user.id;
  const run = data.allocationRuns.find((r) => r.conferenceId === conferenceId && r.runStatus === 'Proposed');
  const proposed = run ? data.allocationProposals.filter((p) => p.allocationRunId === run.id && p.proposedBankerIds.includes(me)) : [];
  return data.meetings
    .filter((m) => m.conferenceId === conferenceId && m.status === 'Confirmed' && fmt(m.start, zone, 'yyyy-MM-dd') === day)
    .map((m) => {
      const seated = m.bankerIds.includes(me) || data.coverageAssignments.some((a) => a.meetingId === m.id && a.bankerId === me);
      const pending = !seated && proposed.some((p) => p.meetingId === m.id);
      return { m, seated, pending };
    })
    .filter((x) => x.seated || x.pending)
    .sort((a, b) => a.m.start.localeCompare(b.m.start));
}

/** Items for me: assigned to me, or about an issuer I own. Escalations pinned, then urgent, then soonest. */
export function myDecisions(data: AppState, open: Action[]) {
  const me = data.user.id;
  // One owner per item: assigned person, else the issuer's coverage banker.
  const mine = open.filter((a) => (a.assignedTo || data.issuers.find((i) => i.id === a.issuerId)?.ownerId) === me);
  const rank = (a: Action) =>
    (actionKind(a, data).id === 'escalation' || a.status === 'Acknowledged' ? 0 : 2) + (a.priority === 'Urgent' ? 0 : 1);
  return mine.sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt));
}

export function MyDay({
  data,
  conferenceId,
  openActions,
  run,
  onItem,
  onOpenMeeting,
  onOpenQueue,
  onOpenSchedule,
  onOpenAudit,
  onOpenType,
  desk,
}: {
  data: AppState;
  conferenceId: string;
  openActions: Action[];
  run: Run;
  onItem: (item: InboxItem) => void;
  onOpenMeeting: (id: string) => void;
  onOpenQueue: () => void;
  onOpenSchedule: () => void;
  onOpenAudit: () => void;
  /** Open the inbox filtered to one of Alex's change types. */
  onOpenType?: (t: ItemKind | 'urgent') => void;
  /** The to-do strip (all open items with the decision below); replaces the separate Inbox page. */
  desk?: React.ReactNode;
}) {
  const n = names(data);
  const c = data.conferences.find((x) => x.id === conferenceId)!;
  const zone = c.timezone;
  const now = new Date(data.now);
  const today = fmt(now.toISOString(), zone, 'yyyy-MM-dd');
  const tomorrow = fmt(new Date(+now + 86400000).toISOString(), zone, 'yyyy-MM-dd');
  // One coordinator handles the whole conference inbox: everything open is theirs.
  const items = inboxItems(data, openActions, zone);
  const me = data.user.id;
  const myIssuers = new Set(data.issuers.filter((i) => i.ownerId === me).map((i) => i.id));
  const myMeetingIds = new Set(data.meetings.filter((m) => myIssuers.has(m.issuerId) || m.bankerIds.includes(me)).map((m) => m.id));
  const lastSeen = (data.user as { lastSeenAt?: string | null }).lastSeenAt || null;
  const changes = data.auditLogs
    .filter((a) => a.actorId !== me && ((a.issuerId && myIssuers.has(a.issuerId)) || (a.meetingId && myMeetingIds.has(a.meetingId))))
    .slice(0, 8);
  const fresh = changes.filter((a) => !lastSeen || a.createdAt > lastSeen).length;
  const pair = (m: Meeting) => `${n.issuer(m.issuerId)} × ${n.investor(m.investorId)}`;
  const room = (m: Meeting) => {
    const r = data.cubeAssignments.find((a) => a.meetingId === m.id);
    return data.meetingCubes.find((x) => x.id === r?.cubeId)?.name || m.location || 'Room to be confirmed';
  };
  const coBankers = (m: Meeting) =>
    [...new Set([...m.bankerIds, ...data.coverageAssignments.filter((a) => a.meetingId === m.id).map((a) => a.bankerId)])]
      .filter((id) => id !== me)
      .map(n.user);
  const detail = (m: Meeting) => [room(m), coBankers(m).length ? `with ${coBankers(m).join(', ')}` : 'you lead'].join(' · ');
  const inEvent = today >= c.startDate && today <= c.endDate;
  const dayNo = Math.round((+new Date(`${today}T12:00:00Z`) - +new Date(`${c.startDate}T12:00:00Z`)) / 86400000) + 1;
  const dayCount = Math.round((+new Date(`${c.endDate}T12:00:00Z`) - +new Date(`${c.startDate}T12:00:00Z`)) / 86400000) + 1;
  const shown = items.slice(0, 5);
  const typeCounts = [
    ['urgent', items.filter((i) => urgentKind(i.type)).length] as const,
    ...kindOrder.filter((k) => k !== 'escalation').map((k) => [k, items.filter((i) => i.type === k).length] as const),
  ].filter(([, n]) => n > 0);

  const daysToGo = Math.round((+new Date(`${c.startDate}T12:00:00Z`) - +new Date(`${today}T12:00:00Z`)) / 86400000);
  // What Corda did on its own: read and sorted the mail behind today's to-dos (and anything new since
  // you last looked), prepared the changes waiting for your OK, matched emails to meetings, flagged
  // look-alike senders. Nothing here changed the schedule; every change still needs approval.
  const since = lastSeen || new Date(+now - 86400000).toISOString();
  const openEmailIds = new Set(items.map((i) => i.email?.id).filter(Boolean) as string[]);
  const handled = data.emails.filter(
    (e) => (!e.conferenceId || e.conferenceId === conferenceId) && (openEmailIds.has(e.id) || e.receivedAt > since),
  );
  const prepared = handled.flatMap((e) => (openEmailIds.has(e.id) ? e.proposals.filter((p) => p.status === 'Pending') : []));
  const cordaDid: { title: string; sub: string; onOpen?: () => void }[] = [];
  if (handled.length) {
    const filed = handled.filter((e) => !openEmailIds.has(e.id)).length;
    cordaDid.push({
      title: `Read and sorted ${handled.length} email${handled.length === 1 ? '' : 's'}`,
      sub: [`${openEmailIds.size} became to-dos`, filed ? `${filed} filed, nothing to do` : ''].filter(Boolean).join(' · '),
    });
  }
  if (prepared.length)
    cordaDid.push({
      title: `Prepared ${prepared.length} change${prepared.length === 1 ? '' : 's'}`,
      sub: 'Each waits for approval · nothing moved yet',
      onOpen: () => document.getElementById('to-review')?.scrollIntoView({ behavior: 'smooth' }),
    });
  for (const e of handled.filter((x) => x.suspicious || x.senderStatus === 'unverified').slice(0, 2))
    cordaDid.push({
      title: 'Flagged a look-alike sender',
      sub: `${(e.originalSender || e.sender).toLowerCase()} · moved to the top`,
      onOpen: items.some((i) => i.email?.id === e.id) ? () => onItem(items.find((i) => i.email?.id === e.id)!) : undefined,
    });
  for (const e of handled) {
    if (cordaDid.length >= 5) break;
    const p = e.proposals.find((q) => (q.extraction as { meetingId?: string | null } | null)?.meetingId);
    const m = p && data.meetings.find((x) => x.id === (p.extraction as { meetingId?: string }).meetingId);
    if (m) cordaDid.push({ title: 'Matched an email to its meeting', sub: `${pair(m)} · ${fmt(m.start, zone, 'MMM d · h:mm a')}`, onOpen: () => onOpenMeeting(m.id) });
  }
  // Alerts: things that will go wrong if nobody acts (not decisions; those are in To review).
  const alerts: { title: string; sub: string; action?: { label: string; run: () => void } }[] = [];
  for (const i of items.filter((x) => x.corda.tone === 'wait').slice(0, 3))
    alerts.push({ title: `${i.who}: ${i.corda.text.toLowerCase().startsWith('waiting') ? i.corda.text : `waiting · ${i.corda.text}`}`, sub: `Received ${fmt(i.at, zone, 'MMM d, h:mm a')}`, action: { label: 'Open', run: () => onItem(i) } });
  const deadline = (c as { preferenceDeadline?: string | null }).preferenceDeadline;
  if (deadline && today <= fmt(deadline, zone, 'yyyy-MM-dd')) {
    const sent = new Set(data.bankerPreferences.filter((p) => p.conferenceId === conferenceId && p.submissionStatus === 'Submitted').map((p) => p.bankerId));
    const missing = data.users.filter((u) => u.role === 'BANKER' && !sent.has(u.id));
    if (missing.length)
      alerts.push({
        title: `Preferences due ${fmt(deadline, zone, 'MMM d')}`,
        sub: `${missing.slice(0, 3).map((u) => u.name.split(' ')[0]).join(', ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''} haven’t sent theirs`,
      });
  }

  return (
    <div className="v5-page">
      <header className="v5-today-head">
        <div>
          <span className="eyebrow">
            {c.name}
            {inEvent ? ` · Day ${dayNo} of ${dayCount}` : today < c.startDate ? ` · in ${daysToGo} day${daysToGo === 1 ? '' : 's'}` : ' · ended'}
          </span>
          <h1>Today</h1>
        </div>
        <nav className="v5-counts" aria-label="Summary">
          <a href="#to-review">
            <b>{items.length}</b> to review
          </a>
          <a href="#alerts">
            <span className="alert-dot" aria-hidden="true" />
            <b>{alerts.length}</b> alert{alerts.length === 1 ? '' : 's'}
          </a>
          <a href="#done-by-corda">
            <CordaMark size={16} />
            <b>{cordaDid.length}</b> done by Corda
          </a>
        </nav>
      </header>

      <HoldsBar data={data} run={run} />

      {desk ?? (
        <>
      <section aria-label="Needs you" className="v5-stack">
        <div className="v5-section-head">
          <h2>Needs you</h2>
          {items.length > 0 && (
            <button className="v5-link" onClick={onOpenQueue}>
              Open inbox
            </button>
          )}
        </div>
        {typeCounts.length > 1 && (
          <div className="v5-kinds today" role="group" aria-label="Open items by type">
            {typeCounts.map(([k, count]) => (
              <button key={k} className={k === 'urgent' ? 'urgent' : ''} onClick={() => onOpenType?.(k as ItemKind | 'urgent')}>
                {k === 'urgent' ? 'Urgent' : itemKindLabel[k as ItemKind]} <span>{count}</span>
              </button>
            ))}
          </div>
        )}
        {shown.length ? (
          shown.map((item, i) => (
            <div key={item.id} className="v5-need">
              <span className={`v5-dot ${item.tone}`} />
              <div className="body">
                <strong>
                  <span className={`v5-kind k-${item.type}`}>{itemKindLabel[item.type]}</span>
                  {item.headline}
                </strong>
                {item.sub && <span>{item.sub}</span>}
              </div>
              <button className={`v5-btn ${i === 0 ? 'primary' : 'quiet'}`} onClick={() => onItem(item)}>
                {item.cta}
              </button>
            </div>
          ))
        ) : (
          <div className="v5-need calm">
            <span className="v5-dot ok" />
            <div className="body">
              <strong>You are all caught up</strong>
              <span>New emails about your issuers appear here as soon as they arrive.</span>
            </div>
          </div>
        )}
        {items.length > shown.length && (
          <button className="v5-link" onClick={onOpenQueue}>
            {items.length - shown.length} more in the inbox
          </button>
        )}
      </section>

        </>
      )}

      <section className="v5-two" aria-label="Done by Corda and alerts">
        <div className="v5-corda-panel" id="done-by-corda">
          <h2>
            <CordaMark size={18} /> Done by Corda
          </h2>
          {cordaDid.length ? (
            cordaDid.map((d, i) => (
              <div key={i} className="v5-row">
                <Check size={16} strokeWidth={2.4} aria-hidden="true" />
                <span>
                  <strong>{d.title}</strong>
                  <span>{d.sub}</span>
                </span>
                {d.onOpen && (
                  <button className="v5-link" onClick={d.onOpen}>
                    Open
                  </button>
                )}
              </div>
            ))
          ) : (
            <p className="v5-none">No new email.</p>
          )}
        </div>
        <div className="v5-alert-panel" id="alerts">
          <h2>
            <span className="alert-dot" aria-hidden="true" /> Alerts
          </h2>
          {alerts.length ? (
            alerts.map((x, i) => (
              <div key={i} className="v5-row">
                <span className="alert-dot" aria-hidden="true" />
                <span>
                  <strong>{x.title}</strong>
                  <span>{x.sub}</span>
                </span>
                {x.action && (
                  <button className="v5-link" onClick={x.action.run}>
                    {x.action.label}
                  </button>
                )}
              </div>
            ))
          ) : (
            <p className="v5-none">No alerts.</p>
          )}
        </div>
      </section>

      {/* Alex: no agenda list here; the day's meetings live on Schedule. */}
      {changes.length > 0 && (
        <section aria-label="What changed" className="v5-stack">
          <div className="v5-section-head">
            <h2>Changed by others{fresh > 0 ? ` · ${fresh} new` : ''}</h2>
            {fresh > 0 && (
              <button className="v5-link" onClick={() => run('markSeen', {}, 'Marked as seen.')}>
                Mark as seen
              </button>
            )}
          </div>
          <div className="v5-card v5-list">
            {changes.map((a) => {
              const m = data.meetings.find((x) => x.id === a.meetingId);
              const isNew = !lastSeen || a.createdAt > lastSeen;
              return (
                <button key={a.id} className={isNew ? 'new' : ''} onClick={() => (m ? onOpenMeeting(m.id) : onOpenAudit())}>
                  <span className="t">{fmt(a.createdAt, zone, 'EEE h:mm a')}</span>
                  <strong>{a.action}</strong>
                  <span>
                    {m ? `${pair(m)} · ` : a.issuerId ? `${n.issuer(a.issuerId)} · ` : ''}
                    {n.user(a.actorId)}
                    {a.note ? ` · “${a.note}”` : ''}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

/** Issuer-wide holds stay visible until someone releases them (not just until the email is acknowledged). */
export function HoldsBar({ data, run }: { data: AppState; run: Run }) {
  const holds = data.issuers.filter((i) => (i as { holdChanges?: boolean }).holdChanges) as (AppState['issuers'][number] & { holdReason?: string; holdSetBy?: string | null })[];
  if (!holds.length) return null;
  const n = names(data);
  return (
    <div className="holds-bar">
      {holds.map((i) => (
        <div key={i.id} className="hold-banner">
          <strong>All changes for {i.name} are on hold</strong>
          <span>
            {i.holdReason || 'Escalation'}
            {i.holdSetBy ? ` · set by ${n.user(i.holdSetBy)}` : ''}
          </span>
          <button className="text-button" onClick={() => run('issuerHold', { issuerId: i.id, hold: false, reason: 'Released from My day' }, `Hold on ${i.name} released.`)}>
            Release hold
          </button>
        </div>
      ))}
    </div>
  );
}
