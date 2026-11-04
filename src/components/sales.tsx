'use client';
import { useState } from 'react';
import { Mail } from 'lucide-react';
import type { AppState } from '@/lib/types';
import { Badge, Empty, fmt } from './shared';

type Email = AppState['emails'][number];

/** Plain words for an ask's review state, as a salesperson sees it. */
export function askState(status: string): { text: string; tone: 'green' | 'amber' | 'red' | 'blue' | '' } {
  switch (status) {
    case 'Pending':
      return { text: 'With the banker', tone: 'blue' };
    case 'Approved':
      return { text: 'Done', tone: 'green' };
    case 'Resolved':
      return { text: 'Handled by the banker', tone: 'green' };
    case 'Clarification requested':
      return { text: 'Banker asked a question', tone: 'amber' };
    case 'Acknowledged':
      return { text: 'Acknowledged, being handled', tone: 'amber' };
    case 'Rejected':
      return { text: 'Not done', tone: 'red' };
    default:
      return { text: status, tone: '' };
  }
}

function myRole(e: Email, me: string) {
  const m = me.toLowerCase();
  if (e.forwardedBy?.toLowerCase() === m) return 'You forwarded';
  if (e.sender.toLowerCase() === m) return 'You sent';
  if (e.cc.some((x) => x.toLowerCase() === m)) return "You're cc'd";
  return 'To you';
}

/**
 * "My emails" for sales: every conference email they sent, forwarded or were copied on,
 * with each ask's status and the banker's reason. No email body, flags or raw extraction.
 */
export function SalesEmailsView({ data, search }: { data: AppState; search: string }) {
  const me = (data.users.find((u) => u.id === data.user.id) as { email?: string } | undefined)?.email || data.user.email;
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const zone = data.conferences[0]?.timezone || 'America/New_York';
  const open = (e: Email) => e.proposals.some((p) => ['Pending', 'Clarification requested', 'Acknowledged'].includes(p.status));
  const emails = data.emails
    .filter((e) => (filter === 'all' || open(e)) && `${e.subject} ${e.originalSenderName || ''} ${e.proposals.map((p) => p.summary).join(' ')}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => +new Date(b.receivedAt) - +new Date(a.receivedAt));
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>My emails</h1>
          <p>Emails you sent, forwarded or were copied on, and what the banker did with each ask.</p>
        </div>
      </div>
      <div className="panel">
        <div className="status-tabs" role="tablist" aria-label="Email filter">
          {(['open', 'all'] as const).map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
              {f === 'open' ? 'In progress' : 'All'}
              <span className="tab-count">{f === 'open' ? data.emails.filter(open).length : data.emails.length}</span>
            </button>
          ))}
        </div>
        {emails.length ? (
          <ul className="sales-emails">
            {emails.map((e) => (
              <li key={e.id}>
                <div className="se-head">
                  <Mail size={14} />
                  <strong>{e.subject}</strong>
                  <small>
                    {myRole(e, me)}
                    {e.originalSenderName ? ` · from ${e.originalSenderName}` : ''} · {fmt(e.receivedAt, zone, 'MMM d, h:mm a')}
                  </small>
                </div>
                {e.proposals.length ? (
                  <ol>
                    {e.proposals.map((p) => {
                      const st = askState(p.status);
                      return (
                        <li key={p.id}>
                          <span className="se-ask">{p.summary || 'Request'}</span>
                          <Badge tone={st.tone || undefined}>{st.text}</Badge>
                          {p.reviewNote && <small className="se-reason">“{p.reviewNote}”</small>}
                        </li>
                      );
                    })}
                  </ol>
                ) : (
                  <small className="se-reason">{e.status === 'Ignored' ? 'Not a conference email.' : e.status}</small>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty title={filter === 'open' ? 'Nothing in progress' : 'No emails yet'} description="Emails you send or forward to the banking desk appear here with their status." />
        )}
      </div>
    </>
  );
}
