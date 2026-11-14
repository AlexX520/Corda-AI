'use client';
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
  const [eventId, setEventId] = useState('');
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
          <select aria-label="Event" className="v5-inline-select" value={eventId} onChange={(e) => setEventId(e.target.value)}>
            <option value="">All events</option>
            {data.conferences.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {' · '}updated {fmt(m.generatedAt, data.conferences[0]?.timezone, 'MMM d, h:mm a')}
        </span>
        <h1>{verdict}</h1>
        <p>{detail}</p>
      </header>

      <section aria-label="Key numbers" className="v5-kpis">
        <button className="v5-card v5-kpi" onClick={() => onOpenMeetings(eventId || undefined)}>
          <span className="l">Meetings confirmed</span>
          <span className="v">{m.totals.meetings}</span>
          <span className="n">{m.totals.requested ? `${pct(m.totals.rate)} of requests granted (${m.totals.confirmed} of ${m.totals.requested})` : 'No requests yet'}</span>
        </button>
        <div className="v5-card v5-kpi">
          <span className="l">Time to confirm</span>
          <span className="v">{hours(m.totals.medianHoursToConfirm)}</span>
          <span className="n">median, request to confirmed meeting · {plural(m.totals.confirmedFromRequests, 'request')}</span>
        </div>
        <button className="v5-card v5-kpi" onClick={() => onOpenAudit({ action: '' })}>
          <span className="l">Hours saved</span>
          <span className="v">{m.roi.hoursSaved} h</span>
          <span className="n">{plural(m.roi.asksHandled, 'request')} handled in Corda · {m.roi.minutesPerAsk} min each, assumed</span>
        </button>
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
            <span style={{ flexGrow: m.emails.approvedClean, background: '#15803d' }} />
            <span style={{ flexGrow: m.emails.approvedEdited, background: '#d97706' }} />
            <span style={{ flexGrow: m.emails.rejected, background: '#a1a1aa' }} />
          </div>
          <div className="v5-legend">
            <span><i style={{ background: '#15803d' }} />Approved as read <b>{m.emails.approvedClean}</b> · {share(m.emails.approvedClean)}</span>
            <span><i style={{ background: '#d97706' }} />Approved after edits <b>{m.emails.approvedEdited}</b> · {share(m.emails.approvedEdited)}</span>
            <span><i style={{ background: '#a1a1aa' }} />Declined by the desk <b>{m.emails.declined}</b> · {share(m.emails.declined)}</span>
            <span>Phishing and noise rejected <b>{m.emails.rejectedNoise}</b></span>
            <span>Still pending <b>{m.emails.pending}</b></span>
          </div>
        </section>
        <section aria-label="Meetings per issuer" className="v5-card v5-panel small">
          <h3>Meetings per issuer</h3>
          {m.perIssuer.slice(0, 6).map((p) => (
            <button key={p.id} className="line" style={{ gridTemplateColumns: 'minmax(0, 1fr) 40px 110px' }} onClick={() => onOpenAudit({ issuer: p.id })}>
              <span>{p.name}</span>
              <strong className="r">{p.meetings}</strong>
              <span className="r q">{p.requested} requested</span>
            </button>
          ))}
        </section>
      </div>
    </div>
  );
}
