'use client';
import { useEffect, useMemo, useState } from 'react';
import { Download, Search } from 'lucide-react';
import type { AppState } from '@/lib/types';
import type { AuditRow } from '@/lib/audit-query';
import { Badge, fmt } from './shared';

type AuditPage = {
  rows: AuditRow[];
  total: number;
  page: number;
  pages: number;
  pageSize: number;
  actions: string[];
  actors: { id: string; name: string }[];
};

/**
 * Audit trail: server-side search, filters and pagination (not limited to the latest 100),
 * readable entries with the reason, links to the email or meeting, and CSV export of the filtered set.
 */
export function AuditTrail({
  data,
  timezone,
  onOpenEmail,
  onOpenMeeting,
  initial,
}: {
  initial?: Record<string, string>;
  data: AppState;
  timezone: string;
  onOpenEmail: (id: string) => void;
  onOpenMeeting: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [actor, setActor] = useState(initial?.actor || '');
  const [action, setAction] = useState('');
  const [issuer, setIssuer] = useState(initial?.issuer || '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<AuditPage | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const params = useMemo(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ q: debounced, actor, action, issuer, from, to })) if (v) p.set(k, v);
    return p;
  }, [debounced, actor, action, issuer, from, to]);
  useEffect(() => setPage(1), [params]);
  // Newest events appear without a reload: refetch when the app's state (and its audit head) changes.
  const head = data.auditLogs[0]?.id;
  useEffect(() => {
    let live = true;
    const p = new URLSearchParams(params);
    p.set('page', String(page));
    setLoading(true);
    fetch(`/api/audit?${p}`)
      .then(async (r) => {
        const out = await r.json();
        if (!r.ok) throw new Error(out.error || 'Could not load the audit trail.');
        if (live) {
          setResult(out);
          setError('');
        }
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Could not load the audit trail.'))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [params, page, head]);

  const exportHref = `/api/audit?${new URLSearchParams([...params, ['format', 'csv']])}`;
  const filtered = Boolean(debounced || actor || action || issuer || from || to);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Audit trail</h1>
          <p>{result ? `${result.total} event${result.total === 1 ? '' : 's'}${filtered ? ' match' : ''}` : 'Loading…'}</p>
        </div>
        <a className="audit-export" href={exportHref} download>
          <Download size={14} /> Export CSV
        </a>
      </div>
      <div className="panel">
        <div className="audit-filters">
          <label className="audit-search">
            <Search size={14} />
            <input aria-label="Search audit trail" placeholder="Search actions, reasons, issuers, investors, subjects…" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <select aria-label="Actor" value={actor} onChange={(e) => setActor(e.target.value)}>
            <option value="">All people</option>
            {result?.actors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <select aria-label="Action" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">All actions</option>
            {result?.actions.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <select aria-label="Issuer" value={issuer} onChange={(e) => setIssuer(e.target.value)}>
            <option value="">All issuers</option>
            {[...data.issuers].sort((a, b) => a.name.localeCompare(b.name)).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <label className="audit-date">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="audit-date">To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          {filtered && (
            <button className="text-button" onClick={() => { setQ(''); setActor(''); setAction(''); setIssuer(''); setFrom(''); setTo(''); }}>
              Clear filters
            </button>
          )}
        </div>
        {error && <p className="error audit-error">{error}</p>}
        <div className={`table-scroll ${loading ? 'loading' : ''}`}>
          <table className="audit-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>By</th>
                <th>Record</th>
                <th>Reason / details</th>
              </tr>
            </thead>
            <tbody>
              {result?.rows.map((a) => (
                <tr key={a.id}>
                  <td className="nowrap">{fmt(a.createdAt, timezone, 'MMM d, h:mm:ss a')}</td>
                  <td><strong>{a.action}</strong></td>
                  <td>{a.actor}</td>
                  <td>
                    {a.entity}
                    {(() => {
                      const type = a.entityType.replace(/([a-z])([A-Z])/g, '$1 $2');
                      const parts = [type !== a.entity && type, a.issuer && !a.entity.includes(a.issuer) && a.issuer].filter(Boolean);
                      return parts.length ? <small>{parts.join(' · ')}</small> : null;
                    })()}
                    <span className="audit-links">
                      {a.emailId && data.emails.some((e) => e.id === a.emailId) && (
                        <button className="text-button" onClick={() => onOpenEmail(a.emailId!)}>Open email</button>
                      )}
                      {a.meetingId && data.meetings.some((m) => m.id === a.meetingId) && (
                        <button className="text-button" onClick={() => onOpenMeeting(a.meetingId!)}>Open meeting</button>
                      )}
                    </span>
                  </td>
                  <td>
                    {a.note && <p className="audit-reason">“{a.note}”</p>}
                    <details>
                      <summary>Before / after</summary>
                      <pre className="audit-json">{JSON.stringify({ before: a.before, after: a.after }, null, 2)}</pre>
                    </details>
                  </td>
                </tr>
              ))}
              {result && !result.rows.length && (
                <tr><td colSpan={5} className="audit-empty">No audit events match these filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {result && result.pages > 1 && (
          <div className="audit-pager">
            <button className="text-button" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Newer</button>
            <Badge>Page {result.page} of {result.pages}</Badge>
            <button className="text-button" disabled={page >= result.pages} onClick={() => setPage(page + 1)}>Older →</button>
          </div>
        )}
      </div>
    </>
  );
}
