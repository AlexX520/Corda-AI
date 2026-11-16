'use client';
import type React from 'react';
import type { AppState } from '@/lib/types';
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
  const todayList = myMeetings(data, conferenceId, today, zone);
  const tomorrowList = myMeetings(data, conferenceId, tomorrow, zone);
  const done = todayList.filter((x) => +new Date(x.m.end) <= +now);
  const live = todayList.find((x) => +new Date(x.m.start) <= +now && +new Date(x.m.end) > +now);
  const upcoming = todayList.filter((x) => +new Date(x.m.start) > +now);
  const next = live || upcoming[0];
  const later = upcoming.filter((x) => x !== next);
  const mins = next ? Math.round((+new Date(next.m.start) - +now) / 60000) : 0;
  const inText = (m: number) => (m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);
  const hour = Number(fmt(now.toISOString(), zone, 'H'));
  const first = data.user.name.split(' ')[0];
  const needLine = items.length ? `${items.length} thing${items.length === 1 ? '' : 's'} need${items.length === 1 ? 's' : ''} you.` : 'Nothing is waiting on you.';
  const nextLine = live
    ? `You are in ${pair(live.m)} until ${fmt(live.m.end, zone, 'h:mm a')}.`
    : next
      ? `Your next meeting starts ${inText(mins)}.`
      : todayList.length
        ? 'Your meetings for today are done.'
        : tomorrowList.length
          ? `No meetings today. ${tomorrowList.length} tomorrow.`
          : 'No meetings today.';
  const shown = items.slice(0, 5);
  // Alex's first three questions: what's new since I last looked, what is still unscheduled, what is confirmed.
  const newSince = items.filter((i) => i.type === 'new' && (!lastSeen || i.at > lastSeen)).length;
  const unscheduled = items.filter((i) => i.type === 'new').length;
  const confirmedCount = data.meetings.filter((m) => m.conferenceId === conferenceId && m.status === 'Confirmed').length;
  const typeCounts = [
    ['urgent', items.filter((i) => urgentKind(i.type)).length] as const,
    ...kindOrder.filter((k) => k !== 'escalation').map((k) => [k, items.filter((i) => i.type === k).length] as const),
  ].filter(([, n]) => n > 0);

  return (
    <div className="v5-page">
      <header className="v5-hero">
        <span className="eyebrow">
          {c.name}
          {inEvent ? ` · Day ${dayNo} of ${dayCount}` : today < c.startDate ? ` · starts ${fmt(`${c.startDate}T12:00:00Z`, 'UTC', 'EEE MMM d')} (in ${Math.round((+new Date(`${c.startDate}T12:00:00Z`) - +new Date(`${today}T12:00:00Z`)) / 86400000)} days)` : ' · ended'}
          {' · '}
          {fmt(now.toISOString(), zone, 'EEE MMM d, h:mm a')}
        </span>
        <h1>
          Good {hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}, {first}.
        </h1>
        <p>
          {needLine} {nextLine}
        </p>
      </header>

      <section aria-label="At a glance" className="v5-glance">
        <button onClick={() => onOpenType?.('new')}>
          <strong>{newSince}</strong>
          <span>New requests since you last looked</span>
        </button>
        <button onClick={() => onOpenType?.('new')}>
          <strong>{unscheduled}</strong>
          <span>Waiting to be scheduled</span>
        </button>
        <button onClick={onOpenSchedule}>
          <strong>{confirmedCount}</strong>
          <span>Confirmed meetings</span>
        </button>
      </section>

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
