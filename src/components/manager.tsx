'use client';
import { Select } from './ui/select-menu';
import { useEffect, useState } from 'react';
import type { AppState } from '@/lib/types';
import { Empty, fmt } from './shared';

type M = NonNullable<AppState['metrics']>;
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
const hours = (h: number | null) => (h === null ? '—' : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${Math.round(h * 10) / 10} h` : `${Math.round(h / 24)} d`);
const age = (h: number) => (h < 24 ? `${h} h` : `${Math.round(h / 24)} d`);

/** Manager home: every event, computed from the live records (plus clearly marked demo history). */
export type Drill = { scope?: 'mine' | 'issuers' | 'everyone'; owner?: string; urgent?: boolean; focus?: 'escalation' | 'all'; status?: string };
export function ManagerHome({
  data,
  onOpenEvent,
  onOpenQueue,
  onOpenMeetings,
  onOpenEmail,
  onOpenAudit,
}: {
  data: AppState;
  onOpenEvent: (id: string) => void;
  onOpenQueue: (d?: Drill) => void;
  onOpenMeetings: (conferenceId?: string) => void;
  onOpenEmail: (id: string) => void;
  onOpenAudit: (q?: Record<string, string>) => void;
}) {
  // Event picker: "All events" uses the metrics in the app state; one event is fetched filtered.
  // Default to the live or upcoming event with the most work in it (issuer counts across events
  // are not comparable); "All events" stays one click away.
  const [eventId, setEventId] = useState(() => {
    const live = (data.metrics?.events || []).filter((e) => e.state !== 'Done');
    const pick = [...live].sort((a, b) => b.openItems + b.meetings - (a.openItems + a.meetings) || a.startDate.localeCompare(b.startDate))[0];
    return pick?.id || '';
  });
  const [scoped, setScoped] = useState<M | null>(null);
  useEffect(() => {
    if (!eventId) return setScoped(null);
    let live = true;
    void fetch('/api/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'metrics', data: { conferenceId: eventId } }) })
      .then((r) => r.json())
      .then((j) => live && setScoped(j.result));
    return () => {
      live = false;
    };
  }, [eventId, data.metrics?.generatedAt]);
  const m = (eventId ? scoped : data.metrics) as M | null;
  if (!m) return <Empty title="Loading metrics" description="Team metrics are available to managers." />;
  const handled = m.emails.approvedClean + m.emails.approvedEdited + m.emails.rejected;
  const share = (n: number) => (handled ? `${Math.round((n / handled) * 100)}%` : '—');
  const esc = m.escalations.length;
  const late = m.unanswered.length;
  const plural = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;
  const verdict = esc || late ? `Your desk needs you in ${plural(esc + late, 'place')}.` : 'Your desk is on track.';
  const detail =
    esc && late
      ? `${plural(esc, 'client escalation')} ${esc === 1 ? 'is' : 'are'} open and ${plural(late, 'issuer email')} ${late === 1 ? 'has' : 'have'} waited more than 4 hours.`
      : esc
        ? `${plural(esc, 'client escalation')} ${esc === 1 ? 'is' : 'are'} open. No issuer email has waited more than 4 hours.`
        : late
          ? `${plural(late, 'issuer email')} ${late === 1 ? 'has' : 'have'} waited more than 4 hours. No escalations are open.`
          : `No escalations are open and no issuer email has waited more than 4 hours. ${plural(m.totals.openItems, 'item')} in the team inbox.`;
  const maxOpen = Math.max(...m.workload.map((w) => w.openItems), 1);
  const oldest = (id: string) => m.openByCoordinator.find((o) => o.userId === id)?.oldestHours;
  return (
    <div className="v5-page wide">
      <header className="v5-hero">
        <span className="eyebrow">
          <Select aria-label="Event" className="v5-inline-select" value={eventId} onChange={(e) => setEventId(e.target.value)}>
            <option value="">All events</option>
            {data.conferences.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          {' · '}updated {fmt(m.generatedAt, data.conferences[0]?.timezone, 'MMM d, h:mm a')}
        </span>
        <h1>{verdict}</h1>
        <p>{detail}</p>
      </header>

      <section aria-label="Key numbers" className="v5-kpis">
        <button className="v5-card v5-kpi" onClick={() => onOpenMeetings(eventId || undefined)}>
          <span className="l">Confirmed meetings</span>
          <span className="v">{m.meetings.confirmed}</span>
          <span className="n">On the schedule, nothing waiting</span>
        </button>
        <a className="v5-card v5-kpi" href="#pending-meetings">
          <span className="l">Pending meetings</span>
          <span className="v">{m.meetings.pending}</span>
          <span className="n">
            {m.meetings.pendingByStage[0]} with the issuer · {plural(m.meetings.pendingByStage[1], 'move')} · {m.meetings.pendingByStage[2]} to confirm
          </span>
        </a>
        <div className="v5-card v5-kpi">
          <span className="l">Total meetings</span>
          <span className="v">{m.meetings.total}</span>
          <span className="n">Confirmed + pending</span>
        </div>
      </section>

      <div className="v5-two">
        <section aria-label="Issuers by confirmed meetings" className="v5-card v5-panel big">
          <h3>
            Issuers by confirmed meetings{eventId ? '' : ' · all events'}
          </h3>
          {m.issuerRanking.length ? (
            m.issuerRanking.map((p) => (
              <button
                key={p.id}
                className={`line ${m.targets.some((t) => t.id === p.id) ? 'target' : ''}`}
                style={{ gridTemplateColumns: 'minmax(0, 1fr) 140px 40px' }}
                onClick={() => onOpenAudit({ issuer: p.id })}
              >
                <span className="two">
                  <span>{p.name}</span>
                  <span className="v5-bar"><span style={{ width: `${(p.confirmed / Math.max(1, ...m.issuerRanking.map((x) => x.confirmed))) * 100}%` }} /></span>
                </span>
                <span className="r q">{p.pending ? `${p.pending} pending` : ''}</span>
                <strong className="r">{p.confirmed}</strong>
              </button>
            ))
          ) : (
            <p className="v5-none">No meetings yet.</p>
          )}
        </section>
        <section aria-label="Target list" className="v5-card v5-panel small v5-targets">
          <h3>Target list</h3>
          <p className="v5-none">
            {eventId ? `The ${m.targetCount} issuers with the fewest confirmed meetings. Schedule more for them first.` : 'Pick an event to see its targets.'}
          </p>
          {m.targets.map((t, i) => (
            <button key={t.id} className="line" style={{ gridTemplateColumns: '22px minmax(0, 1fr) auto' }} onClick={() => onOpenEvent(eventId)}>
              <span className="rank">{i + 1}</span>
              <span className="two">
                <strong>{t.name}</strong>
                <small>
                  {t.confirmed} confirmed{t.pending ? ` · ${t.pending} pending` : ''}
                  {t.openSlots !== null ? ` · ${t.openSlots} open slot${t.openSlots === 1 ? '' : 's'}` : ' · no availability yet'}
                </small>
              </span>
              <span className="r q">Schedule</span>
            </button>
          ))}
        </section>
      </div>

      <section aria-label="Pending meetings" id="pending-meetings" className="v5-card v5-panel v5-pending">
        <h3>Pending meetings · {m.meetings.pending}</h3>
        {([1, 2, 3] as const).map((stage) => {
          const list = m.meetings.pendingItems.filter((p) => p.stage === stage);
          const title = stage === 1 ? 'Requested, issuer has not confirmed' : stage === 2 ? 'Issuer wants to move, investor has not confirmed' : 'Answered, the desk has not confirmed';
          return (
            <div key={stage} className="group">
              <div className="ghead">
                <strong>{title}</strong>
                <span>{list.length}</span>
              </div>
              {list.length ? (
                list.map((p) => (
                  <button
                    key={p.key}
                    className="line"
                    style={{ gridTemplateColumns: 'minmax(0, 1fr) 150px 90px' }}
                    onClick={() => (p.emailId ? onOpenEmail(p.emailId) : onOpenQueue({ scope: 'everyone' }))}
                  >
                    <span>{p.issuer} × {p.investor}</span>
                    <span className="r q">{p.waitingOn === 'Desk' ? (p.stage === 2 ? 'Desk to ask sales' : 'Desk to confirm') : `Waiting on ${p.waitingOn.toLowerCase()}`}</span>
                    <span className="r q">since {fmt(p.since, data.conferences[0]?.timezone, 'MMM d')}</span>
                  </button>
                ))
              ) : (
                <p className="v5-none">None.</p>
              )}
            </div>
          );
        })}
      </section>

      <section aria-label="Needs your attention" className="v5-stack">
        <div className="v5-section-head">
          <h2>Needs your attention</h2>
          <button className="v5-link" onClick={() => onOpenQueue({ scope: 'everyone' })}>Team inbox · {m.totals.openItems}</button>
        </div>
        {m.escalations.map((e) => (
          <div key={e.id} className="v5-need">
            <span className="v5-dot red" />
            <div className="body">
              <strong>{e.title}</strong>
              <span>Client escalation · owned by {e.owner} · open {age(e.ageHours)}</span>
            </div>
            <button className="v5-btn quiet" onClick={() => onOpenQueue({ scope: 'everyone', focus: 'escalation' })}>View</button>
          </div>
        ))}
        {m.unanswered.map((e) => (
          <div key={e.id} className="v5-need">
            <span className="v5-dot amber" />
            <div className="body">
              <strong>{e.issuer}: {e.subject}</strong>
              <span>Issuer email with no reply for {age(e.ageHours)}</span>
            </div>
            <button className="v5-btn quiet" onClick={() => onOpenEmail(e.id)}>Open</button>
          </div>
        ))}
        {!esc && !late && (
          <div className="v5-need calm">
            <span className="v5-dot ok" />
            <div className="body">
              <strong>Nothing overdue</strong>
              <span>Escalations and issuer emails waiting more than 4 hours appear here.</span>
            </div>
          </div>
        )}
      </section>

      <div className="v5-two">
        <section aria-label="Events" className="v5-card v5-panel big">
          <h3>Events</h3>
          {m.events.map((e) => (
            <button key={e.id} className="line" style={{ gridTemplateColumns: 'minmax(0, 1fr) 96px 110px 64px' }} onClick={() => onOpenEvent(e.id)}>
              <span className="two">
                <strong>{e.name}</strong>
                <small>
                  {e.type} · {e.location} · {fmt(`${e.startDate}T12:00:00Z`, 'UTC', 'MMM d')}
                  {e.endDate !== e.startDate ? `–${fmt(`${e.endDate}T12:00:00Z`, 'UTC', 'd')}` : ''} · {e.state.toLowerCase()}
                </small>
              </span>
              <span className="r">{plural(e.meetings, 'meeting')}</span>
              <span className="r q">{e.requested ? `${pct(e.rate)} granted` : 'Planning'}</span>
              <span className="r q">{e.openItems ? `${e.openItems} open` : ''}</span>
            </button>
          ))}
        </section>
        <section aria-label="Team load" className="v5-card v5-panel small">
          <h3>Team load</h3>
          {m.workload.map((w) => (
            <button key={w.userId} className="line" style={{ gridTemplateColumns: 'minmax(0, 1fr) 84px' }} onClick={() => onOpenQueue({ scope: 'everyone', owner: w.userId })}>
              <span className="two">
                <span>{w.name}</span>
                <span className="v5-bar"><span style={{ width: `${(w.openItems / maxOpen) * 100}%` }} /></span>
                <small>{plural(w.meetings, 'meeting')} covered{oldest(w.userId) ? ` · oldest item ${age(oldest(w.userId)!)}` : ''}</small>
              </span>
              <span className="r">{w.openItems} open</span>
            </button>
          ))}
        </section>
      </div>

      <div className="v5-two">
        <section aria-label="How requests were handled" className="v5-card v5-panel big">
          <h3>How email requests were handled</h3>
          <div className="v5-mix" role="img" aria-label={`${m.emails.approvedClean} approved as read, ${m.emails.approvedEdited} approved after edits, ${m.emails.rejected} rejected`}>
            <span style={{ flexGrow: m.emails.approvedClean, background: '#111111' }} />
            <span style={{ flexGrow: m.emails.approvedEdited, background: '#71717a' }} />
            <span style={{ flexGrow: m.emails.rejected, background: '#d4d4d8' }} />
          </div>
          <div className="v5-legend">
            <span><i style={{ background: '#111111' }} />Approved as read <b>{m.emails.approvedClean}</b> · {share(m.emails.approvedClean)}</span>
            <span><i style={{ background: '#71717a' }} />Approved after edits <b>{m.emails.approvedEdited}</b> · {share(m.emails.approvedEdited)}</span>
            <span><i style={{ background: '#d4d4d8' }} />Declined by the desk <b>{m.emails.declined}</b> · {share(m.emails.declined)}</span>
            <span>Phishing and noise rejected <b>{m.emails.rejectedNoise}</b></span>
            <span>Still pending <b>{m.emails.pending}</b></span>
          </div>
        </section>
        <section aria-label="Speed" className="v5-card v5-panel small">
          <h3>Speed</h3>
          <div className="line static" style={{ gridTemplateColumns: 'minmax(0, 1fr) auto' }}>
            <span className="two"><span>Time to confirm</span><small>median, request to confirmed meeting · {plural(m.totals.confirmedFromRequests, 'request')}</small></span>
            <strong className="r">{hours(m.totals.medianHoursToConfirm)}</strong>
          </div>
          <button className="line" style={{ gridTemplateColumns: 'minmax(0, 1fr) auto' }} onClick={() => onOpenAudit({ action: '' })}>
            <span className="two"><span>Hours saved</span><small>{plural(m.roi.asksHandled, 'request')} handled in Corda · {m.roi.minutesPerAsk} min each, assumed</small></span>
            <strong className="r">{m.roi.hoursSaved} h</strong>
          </button>
          <div className="line static" style={{ gridTemplateColumns: 'minmax(0, 1fr) auto' }}>
            <span className="two"><span>Requests granted</span><small>{m.totals.confirmed} of {m.totals.requested} requests</small></span>
            <strong className="r">{pct(m.totals.rate)}</strong>
          </div>
        </section>
      </div>
    </div>
  );
}
