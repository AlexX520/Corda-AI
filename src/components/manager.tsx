'use client';
import { Select } from './ui/select-menu';
import { useEffect, useState } from 'react';
import type { AppState } from '@/lib/types';
import { Empty, fmt } from './shared';

type M = NonNullable<AppState['metrics']>;

export type Drill = { scope?: 'mine' | 'issuers' | 'everyone'; owner?: string; urgent?: boolean; focus?: 'escalation' | 'all'; status?: string };
/** Desk head home (Tao, Nov 24): Confirmed / Pending / Total, issuers by confirmed meetings with the
 * target list, and banker coverage. Nothing else; the numbers are not links. */
export function ManagerHome({
  data,
  onOpenEvent,
}: {
  data: AppState;
  onOpenEvent: (id: string) => void;
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
  const plural = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;
  const maxCover = Math.max(...m.workload.map((w) => w.meetings), 1);
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
        <h1>Desk overview</h1>
      </header>

      <section aria-label="Key numbers" className="v5-kpis">
        <div className="v5-card v5-kpi">
          <span className="l">Confirmed meetings</span>
          <span className="v">{m.meetings.confirmed}</span>
          <span className="n">On the schedule, nothing waiting</span>
        </div>
        <div className="v5-card v5-kpi">
          <span className="l">Pending meetings</span>
          <span className="v">{m.meetings.pending}</span>
          <span className="n">
            {m.meetings.pendingByStage[0]} with the issuer · {plural(m.meetings.pendingByStage[1], 'move')} · {m.meetings.pendingByStage[2]} to confirm
          </span>
        </div>
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
              <div
                key={p.id}
                className={`line static ${m.targets.some((t) => t.id === p.id) ? 'target' : ''}`}
                style={{ gridTemplateColumns: 'minmax(0, 1fr) 140px 40px' }}
              >
                <span className="two">
                  <span>{p.name}</span>
                  <span className="v5-bar"><span style={{ width: `${(p.confirmed / Math.max(1, ...m.issuerRanking.map((x) => x.confirmed))) * 100}%` }} /></span>
                </span>
                <span className="r q">{p.pending ? `${p.pending} pending` : ''}</span>
                <strong className="r">{p.confirmed}</strong>
              </div>
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

      <section aria-label="Banker coverage" className="v5-card v5-panel v5-coverage">
        <h3>
          Banker coverage{eventId ? '' : ' · all events'}
          <span className="q">{m.uncovered ? `${plural(m.uncovered, 'confirmed meeting')} without a banker` : 'Every confirmed meeting has a banker'}</span>
        </h3>
        {m.workload.length ? (
          m.workload.map((w) => (
            <div key={w.userId} className="line static" style={{ gridTemplateColumns: 'minmax(0, 1fr) 120px 40px' }}>
              <span className="two">
                <span>{w.name}</span>
                <span className="v5-bar"><span style={{ width: `${(w.meetings / maxCover) * 100}%` }} /></span>
              </span>
              <span className="r q">{w.next7Days ? `${w.next7Days} in the next 7 days` : ''}</span>
              <strong className="r">{w.meetings}</strong>
            </div>
          ))
        ) : (
          <p className="v5-none">No bankers yet.</p>
        )}
      </section>
    </div>
  );
}
