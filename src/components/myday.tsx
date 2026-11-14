'use client';
import type { AppState } from '@/lib/types';
import { actionKind } from './queue-model';
import { inboxItems, type InboxItem } from './inbox-model';
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
  const mine = open.filter((a) => a.assignedTo === me || data.issuers.find((i) => i.id === a.issuerId)?.ownerId === me);
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
}) {
  const n = names(data);
  const c = data.conferences.find((x) => x.id === conferenceId)!;
  const zone = c.timezone;
  const now = new Date(data.now);
  const today = fmt(now.toISOString(), zone, 'yyyy-MM-dd');
  const tomorrow = fmt(new Date(+now + 86400000).toISOString(), zone, 'yyyy-MM-dd');
  const items = inboxItems(data, myDecisions(data, openActions), zone);
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

  return (
    <div className="v5-page">
      <header className="v5-hero">
        <span className="eyebrow">
          {c.name}
          {inEvent ? ` · Day ${dayNo} of ${dayCount}` : today < c.startDate ? ` · starts ${fmt(`${c.startDate}T12:00:00Z`, 'UTC', 'EEE MMM d')}` : ' · ended'}
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

      <HoldsBar data={data} run={run} />

      {next && (
        <section aria-label="Next meeting" className="v5-card v5-next">
          <div className="when">
            <strong>{live ? 'NOW' : 'NEXT'} · {fmt(next.m.start, zone, 'h:mm a')}</strong>
            <span>{live ? `until ${fmt(next.m.end, zone, 'h:mm a')}` : inText(mins)}</span>
          </div>
          <div className="what">
            <strong>{pair(next.m)}</strong>
            <span>
              {detail(next.m)} · {next.m.expectedAttendees} attendees{next.pending ? ' · seat not approved yet' : ''}
            </span>
          </div>
          <button className="v5-btn quiet" onClick={() => onOpenMeeting(next.m.id)}>
            Open meeting
          </button>
        </section>
      )}

      <section aria-label="Needs you" className="v5-stack">
        <div className="v5-section-head">
          <h2>Needs you</h2>
          {items.length > 0 && (
            <button className="v5-link" onClick={onOpenQueue}>
              Open inbox
            </button>
          )}
        </div>
        {shown.length ? (
          shown.map((item, i) => (
            <div key={item.id} className="v5-need">
              <span className={`v5-dot ${item.tone}`} />
              <div className="body">
                <strong>{item.headline}</strong>
                <span>{item.sub}</span>
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

      {(later.length > 0 || tomorrowList.length > 0 || done.length > 0) && (
        <section aria-label="Schedule" className="v5-stack">
          <div className="v5-section-head">
            <h2>{later.length ? 'Later today' : tomorrowList.length ? 'Tomorrow' : 'Earlier today'}</h2>
            <button className="v5-link" onClick={onOpenSchedule}>
              Full schedule
            </button>
          </div>
          {later.length > 0 && (
            <div className="v5-tiles">
              {later.map(({ m, pending }) => (
                <button key={m.id} className="v5-tile" onClick={() => onOpenMeeting(m.id)}>
                  <span className="t">{fmt(m.start, zone, 'h:mm a')}{pending ? ' · seat pending' : ''}</span>
                  <strong>{pair(m)}</strong>
                  <span>{detail(m)}</span>
                </button>
              ))}
            </div>
          )}
          {tomorrowList.length > 0 && (
            <>
              {later.length > 0 && <h2 className="v5-sub">Tomorrow</h2>}
              <div className="v5-card v5-list">
                {tomorrowList.map(({ m, pending }) => (
                  <button key={m.id} onClick={() => onOpenMeeting(m.id)}>
                    <span className="t">{fmt(m.start, zone, 'h:mm a')}</span>
                    <strong>{pair(m)}</strong>
                    <span>{detail(m)}{pending ? ' · seat pending' : ''}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {done.length > 0 && (
            <details className="v5-details">
              <summary>{done.length} done earlier today</summary>
              <div className="v5-card v5-list muted">
                {done.map(({ m }) => (
                  <button key={m.id} onClick={() => onOpenMeeting(m.id)}>
                    <span className="t">{fmt(m.start, zone, 'h:mm a')}</span>
                    <strong>{pair(m)}</strong>
                    <span>{room(m)}</span>
                  </button>
                ))}
              </div>
            </details>
          )}
        </section>
      )}

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
