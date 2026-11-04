'use client';
import { ArrowRight, CalendarDays, CheckCheck, Clock3, History } from 'lucide-react';
import type { AppState } from '@/lib/types';
import { actionKind, askOf } from './queue-model';
import { Button } from './ui/button';
import { Badge, Empty, fmt, names, type Run } from './shared';

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
  onAction,
  onOpenMeeting,
  onOpenQueue,
  onOpenAudit,
}: {
  data: AppState;
  conferenceId: string;
  openActions: Action[];
  run: Run;
  onAction: (a: Action) => void;
  onOpenMeeting: (id: string) => void;
  onOpenQueue: () => void;
  onOpenAudit: () => void;
}) {
  const n = names(data);
  const c = data.conferences.find((x) => x.id === conferenceId)!;
  const zone = c.timezone;
  const now = new Date();
  const today = fmt(now.toISOString(), zone, 'yyyy-MM-dd');
  const tomorrow = fmt(new Date(+now + 86400000).toISOString(), zone, 'yyyy-MM-dd');
  const days = [
    { key: today, label: 'Today' },
    { key: tomorrow, label: 'Tomorrow' },
  ];
  const decisions = myDecisions(data, openActions);
  const me = data.user.id;
  const myIssuers = new Set(data.issuers.filter((i) => i.ownerId === me).map((i) => i.id));
  const myMeetingIds = new Set(data.meetings.filter((m) => myIssuers.has(m.issuerId) || m.bankerIds.includes(me)).map((m) => m.id));
  const lastSeen = (data.user as { lastSeenAt?: string | null }).lastSeenAt || null;
  const changes = data.auditLogs
    .filter((a) => a.actorId !== me && ((a.issuerId && myIssuers.has(a.issuerId)) || (a.meetingId && myMeetingIds.has(a.meetingId))))
    .slice(0, 12);
  const fresh = changes.filter((a) => !lastSeen || a.createdAt > lastSeen).length;
  const meetingLabel = (m: Meeting) => `${n.issuer(m.issuerId)} × ${n.investor(m.investorId)}`;
  const room = (m: Meeting) => {
    const r = data.cubeAssignments.find((a) => a.meetingId === m.id);
    return data.meetingCubes.find((x) => x.id === r?.cubeId)?.name || m.location || 'Room TBC';
  };
  const coBankers = (m: Meeting) =>
    [...new Set([...m.bankerIds, ...data.coverageAssignments.filter((a) => a.meetingId === m.id).map((a) => a.bankerId)])]
      .filter((id) => id !== me)
      .map(n.user);
  const inEvent = today >= c.startDate && today <= c.endDate;

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>My day</h1>
          <p>
            {fmt(now.toISOString(), zone, 'EEEE, MMMM d')} · {c.name}
            {inEvent ? ' is on' : today < c.startDate ? ` starts ${fmt(`${c.startDate}T12:00:00Z`, 'UTC', 'EEE MMM d')}` : ' has ended'}
          </p>
        </div>
        <Button variant="outline" onClick={onOpenQueue}>
          <CheckCheck size={15} /> Full queue · {openActions.length}
        </Button>
      </div>
      <div className="myday-grid">
        <section className="panel myday-meetings">
          <div className="panel-heading">
            <h3>
              <CalendarDays size={14} /> My meetings
            </h3>
          </div>
          {days.map((d) => {
            const list = myMeetings(data, conferenceId, d.key, zone);
            return (
              <div key={d.key} className="myday-day">
                <h4>
                  {d.label} <small>{fmt(`${d.key}T12:00:00Z`, 'UTC', 'EEE MMM d')}</small>
                </h4>
                {list.length ? (
                  <ul>
                    {list.map(({ m, pending }) => (
                      <li key={m.id}>
                        <button onClick={() => onOpenMeeting(m.id)}>
                          <span className="md-time">{fmt(m.start, zone, 'h:mm a')}</span>
                          <span className="md-what">
                            <strong>{n.investor(m.investorId)}</strong>
                            <small>
                              with {n.issuer(m.issuerId)} · {room(m)}
                              {coBankers(m).length ? ` · with ${coBankers(m).join(', ')}` : ''}
                            </small>
                          </span>
                          {pending && <Badge tone="amber">Pending</Badge>}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">No meetings for you{d.key < c.startDate || d.key > c.endDate ? ` (${c.name} runs ${fmt(`${c.startDate}T12:00:00Z`, 'UTC', 'MMM d')}–${fmt(`${c.endDate}T12:00:00Z`, 'UTC', 'MMM d')})` : ''}.</p>
                )}
              </div>
            );
          })}
          <p className="myday-foot muted">“Pending” seats come from the allocation proposal and are not approved yet.</p>
        </section>
        <section className="panel myday-decisions">
          <div className="panel-heading">
            <h3>Needs my decision <span className="tab-count">{decisions.length}</span></h3>
          </div>
          {decisions.length ? (
            <ul>
              {decisions.slice(0, 8).map((a) => {
                const kind = actionKind(a, data);
                const { email, proposal } = askOf(a, data);
                return (
                  <li key={a.id}>
                    <button onClick={() => onAction(a)}>
                      <span className={`kind-tag kind-${kind.id}`}>{kind.label}</span>
                      <span className="md-what">
                        <strong>{proposal?.summary || a.title}</strong>
                        <small>
                          {a.status === 'Acknowledged' ? 'Acknowledged · yours · ' : a.priority === 'Urgent' ? 'Urgent · ' : ''}
                          {email ? `from ${email.originalSenderName || email.sender}` : a.recommendation}
                        </small>
                      </span>
                      <ArrowRight size={14} />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <Empty title="Nothing waiting on you" description="Items assigned to you or your issuers appear here." />
          )}
          {decisions.length > 8 && (
            <button className="text-button" onClick={onOpenQueue}>
              {decisions.length - 8} more in the queue <ArrowRight size={13} />
            </button>
          )}
        </section>
        <section className="panel myday-changes">
          <div className="panel-heading">
            <h3>
              <History size={14} /> What changed {fresh > 0 && <span className="tab-count hot">{fresh} new</span>}
            </h3>
            {fresh > 0 && (
              <button className="text-button" onClick={() => run('markSeen', {}, 'Marked as seen.')}>
                Mark as seen
              </button>
            )}
          </div>
          {changes.length ? (
            <ul>
              {changes.map((a) => {
                const m = data.meetings.find((x) => x.id === a.meetingId);
                const isNew = !lastSeen || a.createdAt > lastSeen;
                return (
                  <li key={a.id} className={isNew ? 'new' : ''}>
                    <button onClick={() => (m ? onOpenMeeting(m.id) : onOpenAudit())}>
                      <span className="md-what">
                        <strong>{a.action}</strong>
                        <small>
                          {m ? `${meetingLabel(m)} · ` : a.issuerId ? `${n.issuer(a.issuerId)} · ` : ''}
                          {n.user(a.actorId)} · {fmt(a.createdAt, zone, 'EEE h:mm a')}
                        </small>
                        {a.note && <em>“{a.note}”</em>}
                      </span>
                      <Clock3 size={13} />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted">No changes by others to your issuers or meetings.</p>
          )}
        </section>
      </div>
    </>
  );
}
