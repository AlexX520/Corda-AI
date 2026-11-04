'use client';
import { AlertTriangle, CalendarRange, Clock3, Inbox, Users } from 'lucide-react';
import type { AppState } from '@/lib/types';
import { Badge, Empty, fmt } from './shared';

type M = NonNullable<AppState['metrics']>;
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
const hours = (h: number | null) => (h === null ? '—' : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${Math.round(h * 10) / 10} h` : `${Math.round(h / 24)} d`);
const age = (h: number) => (h < 24 ? `${h} h` : `${Math.round(h / 24)} d`);

function Kpi({ label, value, hint, tone }: { label: string; value: string | number; hint?: string; tone?: 'amber' | 'red' }) {
  return (
    <div className={`kpi ${tone || ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {hint && <small>{hint}</small>}
    </div>
  );
}

/** Manager home: every event, computed from the live records (plus clearly marked demo history). */
export function ManagerHome({ data, onOpenEvent, onOpenQueue }: { data: AppState; onOpenEvent: (id: string) => void; onOpenQueue: () => void }) {
  const m = data.metrics as M | null;
  if (!m) return <Empty title="No metrics" description="Team metrics are available to managers." />;
  const handled = m.emails.approvedClean + m.emails.approvedEdited + m.emails.rejected;
  const share = (n: number) => (handled ? `${Math.round((n / handled) * 100)}%` : '—');
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Team overview</h1>
          <p>All events · updated {fmt(m.generatedAt, data.conferences[0]?.timezone, 'MMM d, h:mm a')}</p>
        </div>
      </div>
      <div className="kpi-row">
        <Kpi label="Confirmed meetings" value={m.totals.meetings} />
        <Kpi label="Fill rate" value={pct(m.totals.rate)} hint={`${m.totals.confirmed} of ${m.totals.requested} requests`} />
        <Kpi label="Median time to confirm" value={hours(m.totals.medianHoursToConfirm)} hint={`${m.totals.confirmedFromRequests} requests`} />
        <Kpi label="Open items" value={m.totals.openItems} />
        <Kpi label="Escalations open" value={m.totals.escalationsOpen} tone={m.totals.escalationsOpen ? 'red' : undefined} />
        <Kpi label="Issuer emails > 4 h" value={m.totals.unansweredIssuerEmails} tone={m.totals.unansweredIssuerEmails ? 'amber' : undefined} hint="waiting on us" />
      </div>
      <div className="mgr-grid">
        <section className="panel mgr-events">
          <div className="panel-heading"><h3><CalendarRange size={14} /> Events</h3></div>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Event</th><th>Type</th><th>Dates</th><th>Meetings</th><th>Fill rate</th><th>Open</th></tr></thead>
              <tbody>
                {m.events.map((e) => (
                  <tr key={e.id} className="clickable" onClick={() => onOpenEvent(e.id)}>
                    <td><strong>{e.name}</strong><small>{e.location}</small></td>
                    <td><Badge tone={e.type === 'NDR' ? 'blue' : e.type === 'Roadshow' ? 'amber' : undefined}>{e.type}</Badge></td>
                    <td>{fmt(`${e.startDate}T12:00:00Z`, 'UTC', 'MMM d')}{e.endDate !== e.startDate ? `–${fmt(`${e.endDate}T12:00:00Z`, 'UTC', 'MMM d')}` : ''}<small>{e.state}</small></td>
                    <td>{e.meetings}</td>
                    <td>{pct(e.rate)}<small>{e.confirmed}/{e.requested}</small></td>
                    <td>{e.openItems}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="panel mgr-emails">
          <div className="panel-heading"><h3><Inbox size={14} /> Email asks handled</h3></div>
          <div className="mgr-bar" aria-label="Email asks handled">
            <span className="clean" style={{ flexGrow: m.emails.approvedClean }} />
            <span className="edited" style={{ flexGrow: m.emails.approvedEdited }} />
            <span className="rejected" style={{ flexGrow: m.emails.rejected }} />
          </div>
          <ul className="mgr-legend">
            <li><i className="clean" /> Approved as read <b>{m.emails.approvedClean}</b> <small>{share(m.emails.approvedClean)}</small></li>
            <li><i className="edited" /> Approved after edits <b>{m.emails.approvedEdited}</b> <small>{share(m.emails.approvedEdited)}</small></li>
            <li><i className="rejected" /> Rejected <b>{m.emails.rejected}</b> <small>{share(m.emails.rejected)}</small></li>
            <li><i /> Still pending <b>{m.emails.pending}</b></li>
          </ul>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h3><Clock3 size={14} /> Open items per coordinator</h3>
            <button className="text-button" onClick={onOpenQueue}>Open queue</button>
          </div>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Coordinator</th><th>Open</th><th>Oldest</th></tr></thead>
              <tbody>
                {m.openByCoordinator.map((o) => (
                  <tr key={o.userId || 'none'}><td>{o.name}</td><td>{o.open}</td><td className={o.oldestHours > 24 ? 'warn-text' : ''}>{age(o.oldestHours)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="panel">
          <div className="panel-heading"><h3><AlertTriangle size={14} /> Needs attention</h3></div>
          <ul className="mgr-list">
            {m.escalations.map((e) => (
              <li key={e.id}><Badge tone="red">Escalation</Badge> <span>{e.title}</span> <small>{e.owner} · {age(e.ageHours)}</small></li>
            ))}
            {m.unanswered.map((e) => (
              <li key={e.id}><Badge tone="amber">No reply {age(e.ageHours)}</Badge> <span>{e.issuer}: {e.subject}</span></li>
            ))}
            {!m.escalations.length && !m.unanswered.length && <li className="muted">Nothing overdue.</li>}
          </ul>
        </section>
        <section className="panel mgr-workload">
          <div className="panel-heading"><h3><Users size={14} /> Team workload</h3></div>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Person</th><th>Meetings covered</th><th>Next 7 days</th><th>Open items</th></tr></thead>
              <tbody>
                {m.workload.map((w) => {
                  const max = Math.max(...m.workload.map((x) => x.meetings), 1);
                  return (
                    <tr key={w.userId}>
                      <td>{w.name}</td>
                      <td><span className="mgr-meter"><i style={{ width: `${(w.meetings / max) * 100}%` }} /></span>{w.meetings}</td>
                      <td>{w.next7Days}</td>
                      <td>{w.openItems}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
        <section className="panel">
          <div className="panel-heading"><h3>Meetings per issuer</h3></div>
          <ul className="mgr-rank">{m.perIssuer.slice(0, 8).map((p) => <li key={p.id}><span>{p.name}</span><b>{p.meetings}</b><small>{p.requested} requested</small></li>)}</ul>
        </section>
        <section className="panel">
          <div className="panel-heading"><h3>Meetings per investor</h3></div>
          <ul className="mgr-rank">{m.perInvestor.slice(0, 8).map((p) => <li key={p.id}><span>{p.name}</span><b>{p.meetings}</b><small>{p.requested} requested</small></li>)}</ul>
        </section>
      </div>
      {m.demoRecords > 0 && (
        <p className="muted mgr-foot">Includes {m.demoRecords} seeded demo-history emails and their requests (marked “demo history”) so the trends are visible in the demo.</p>
      )}
    </>
  );
}
