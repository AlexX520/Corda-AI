'use client';
import { useEffect, useState } from 'react';
import type { AuditRow } from '@/lib/audit-query';
import { fmt } from './shared';

/** Plain verbs for the audit actions people care about in a record's history. */
function describe(r: AuditRow) {
  const a = r.action;
  if (/^Meeting created/i.test(a)) return 'Meeting created by hand';
  if (/^Meeting approved/i.test(a)) return 'Meeting approved and confirmed';
  if (/^Meeting requested/i.test(a)) return 'Requested';
  if (/^Ask approved/i.test(a)) return `Approved from email: ${r.entity}`;
  if (/^Ask rejected/i.test(a)) return `Declined from email: ${r.entity}`;
  if (/clarification/i.test(a)) return `Asked the sender a question about: ${r.entity}`;
  if (/Sent through Outlook|Delivery approved and simulated/i.test(a)) return `Email sent: ${r.entity}`;
  if (/^Draft saved|Communication drafted|Reply drafted/i.test(a)) return `Draft prepared: ${r.entity}`;
  return a;
}

/**
 * Readable timeline of one meeting or request: created from which email, who approved,
 * moves and cancellations with reasons, emails sent. Newest first.
 */
export function HistoryTimeline({ meetingId, requestId, timezone, onOpenEmail }: { meetingId?: string; requestId?: string; timezone: string; onOpenEmail?: (id: string) => void }) {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const q = new URLSearchParams({ pageSize: '200', ...(meetingId ? { meeting: meetingId } : {}), ...(requestId ? { request: requestId } : {}) });
    fetch(`/api/audit?${q}`)
      .then(async (r) => {
        const out = await r.json();
        if (!r.ok) throw new Error(out.error || 'History is not available.');
        if (live) setRows(out.rows);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : 'History is not available.'));
    return () => {
      live = false;
    };
  }, [meetingId, requestId]);
  if (error) return <p className="muted">{error}</p>;
  if (!rows) return <p className="muted">Loading history…</p>;
  if (!rows.length) return <p className="muted">No recorded changes yet.</p>;
  return (
    <ol className="history-timeline">
      {rows.map((r) => (
        <li key={r.id}>
          <span className="ht-dot" />
          <div>
            <strong>{describe(r)}</strong>
            <small>
              {r.actor} · {fmt(r.createdAt, timezone, 'EEE MMM d, h:mm a')}
            </small>
            {r.note && <em>“{r.note}”</em>}
            {r.emailId && onOpenEmail && (
              <button className="text-button" onClick={() => onOpenEmail(r.emailId!)}>
                Source email
              </button>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
