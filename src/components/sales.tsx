'use client';
import { useState } from 'react';
import { Mail } from 'lucide-react';
import type { AppState } from '@/lib/types';
import { Badge, Empty, fmt, names, type Run } from './shared';
import { QuickRequest, requestStatus } from './views';

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

type Row = {
  key: string;
  kind: 'Meeting' | 'Request';
  investorId: string;
  issuerId: string;
  conferenceId: string;
  start: string;
  status: { text: string; tone: string };
  reason: string;
  priority: string;
  open: () => void;
};

/**
 * Sales home, "My clients": every request and meeting for the accounts I cover (and my own
 * requests), with status and reason, what changed, one-line Find a time, and the client itinerary.
 */
export function SalesHome({
  data,
  conferenceId,
  run,
  onOpenRequest,
  onOpenMeeting,
  onOpenEmails,
}: {
  data: AppState;
  conferenceId: string;
  run: Run;
  onOpenRequest: (id: string) => void;
  onOpenMeeting: (id: string) => void;
  onOpenEmails: () => void;
}) {
  const n = names(data);
  const c = data.conferences.find((x) => x.id === conferenceId)!;
  const zone = c.timezone;
  const clients = data.investors.filter((i) => i.coverageSalesId === data.user.id);
  const [client, setClient] = useState<string>('all');
  const [copied, setCopied] = useState(false);
  const mine = (investorId: string) => client === 'all' || client === investorId;
  const rows: Row[] = [
    ...data.meetings
      .filter((m) => m.conferenceId === conferenceId && m.status !== 'Cancelled' && mine(m.investorId))
      .map((m) => ({
        key: m.id,
        kind: 'Meeting' as const,
        investorId: m.investorId,
        issuerId: m.issuerId,
        conferenceId: m.conferenceId,
        start: m.start,
        status: { text: m.status, tone: m.status === 'Confirmed' ? 'green' : '' },
        reason: m.changedAt ? `Changed ${fmt(m.changedAt, zone, 'EEE h:mm a')}${m.changeSummary ? `: ${m.changeSummary}` : ''}` : m.location || '',
        priority: data.requests.find((r) => r.id === m.requestId)?.priority || '—',
        open: () => onOpenMeeting(m.id),
      })),
    ...data.requests
      .filter((r) => r.conferenceId === conferenceId && !['Confirmed'].includes(r.status) && mine(r.investorId))
      .map((r) => {
        const st = requestStatus(r, 'SALES');
        return {
          key: r.id,
          kind: 'Request' as const,
          investorId: r.investorId,
          issuerId: r.issuerId,
          conferenceId: r.conferenceId,
          start: r.start,
          status: { text: st.text, tone: st.tone },
          reason: r.reason || st.hint,
          priority: r.priority,
          open: () => onOpenRequest(r.id),
        };
      }),
  ].sort((a, b) => a.start.localeCompare(b.start));
  // Change feed: notices to me, plus changes to my clients' meetings.
  const feed = [
    ...data.notifications.map((x) => ({ id: x.id, at: x.createdAt, text: x.text, unread: !x.readAt })),
    ...data.meetings
      .filter((m) => m.changedAt && m.changedBy !== data.user.id && clients.some((cl) => cl.id === m.investorId))
      .map((m) => ({ id: `m-${m.id}`, at: m.changedAt!, text: `${n.investor(m.investorId)} × ${n.issuer(m.issuerId)}: ${m.changeSummary || 'updated'}`, unread: false })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .filter((x, i, all) => all.findIndex((y) => y.text === x.text) === i)
    .slice(0, 10);
  const itineraryFor = client !== 'all' ? client : clients[0]?.id;
  const itinerary = data.meetings
    .filter((m) => m.conferenceId === conferenceId && m.status === 'Confirmed' && m.investorId === itineraryFor)
    .sort((a, b) => a.start.localeCompare(b.start));
  const emailText = itineraryFor
    ? [
        `Subject: ${c.name} — your meeting schedule`,
        '',
        'Hi,',
        '',
        `Here is your confirmed schedule for ${c.name} (${c.location}; times are ${zone.replace('_', ' ')}):`,
        '',
        ...itinerary.map((m) => `• ${fmt(m.start, zone, 'EEE MMM d, h:mm a')}–${fmt(m.end, zone, 'h:mm a')}  ${n.issuer(m.issuerId)}${m.location ? ` — ${m.location}` : ''}`),
        ...(itinerary.length ? [] : ['(No confirmed meetings yet.)']),
        '',
        'Let me know if anything needs to change.',
        '',
        'Best regards,',
        data.user.name,
      ].join('\n')
    : '';
  async function copy() {
    try {
      await navigator.clipboard.writeText(emailText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }
  const today = fmt(data.now, zone, 'yyyy-MM-dd');
  const inEvent = today >= c.startDate && today <= c.endDate;
  const dayNo = Math.round((+new Date(`${today}T12:00:00Z`) - +new Date(`${c.startDate}T12:00:00Z`)) / 86400000) + 1;
  const dayCount = Math.round((+new Date(`${c.endDate}T12:00:00Z`) - +new Date(`${c.startDate}T12:00:00Z`)) / 86400000) + 1;
  const confirmedAll = data.meetings.filter((m) => m.conferenceId === conferenceId && m.status === 'Confirmed' && clients.some((cl) => cl.id === m.investorId));
  const waitingAll = data.requests.filter((r) => r.conferenceId === conferenceId && !['Confirmed', 'Cancelled'].includes(r.status) && clients.some((cl) => cl.id === r.investorId));
  const card = (id: string) => {
    const meetings = confirmedAll.filter((m) => m.investorId === id);
    const waiting = waitingAll.filter((r) => r.investorId === id).length;
    const cancelled = data.meetings.filter((m) => m.conferenceId === conferenceId && m.investorId === id && m.status === 'Cancelled' && m.changedAt && fmt(m.changedAt, zone, 'yyyy-MM-dd') === today).length;
    const note = cancelled
      ? { text: `${cancelled} cancelled today`, tone: 'warn' }
      : waiting
        ? { text: `${waiting} request${waiting === 1 ? '' : 's'} waiting`, tone: '' }
        : meetings.length
          ? { text: 'All confirmed', tone: 'ok' }
          : { text: 'No meetings yet', tone: '' };
    return { count: `${meetings.length} meeting${meetings.length === 1 ? '' : 's'}`, note };
  };
  return (
    <div className="v5-page wide">
      <header className="v5-hero">
        <span className="eyebrow">
          {c.name}
          {inEvent ? ` · Day ${dayNo} of ${dayCount}` : ''} · {clients.length} account{clients.length === 1 ? '' : 's'} you cover
        </span>
        <h1>
          Your clients have {confirmedAll.length} meeting{confirmedAll.length === 1 ? '' : 's'}.
        </h1>
        <p>
          {waitingAll.length ? `${waitingAll.length} request${waitingAll.length === 1 ? ' is' : 's are'} still waiting on the desk. ` : ''}
          {feed.length ? `Latest change: ${feed[0].text}` : 'No changes to their meetings yet.'}
        </p>
      </header>
      <SalesAnswers data={data} conferenceId={conferenceId} run={run} />
      <section aria-label="Ask for meetings" className="v5-card v5-quick">
        <QuickRequest data={data} conferenceId={conferenceId} run={run} />
      </section>
      <section aria-label="Clients" className="v5-stack">
        <div className="v5-section-head">
          <h2>Clients</h2>
          <button className="v5-link" onClick={onOpenEmails}>
            My emails
          </button>
        </div>
        <div className="v5-clients" role="tablist" aria-label="Client">
          <button className={`v5-client ${client === 'all' ? 'on' : ''}`} onClick={() => setClient('all')}>
            <strong>All clients</strong>
            <span>{confirmedAll.length} meetings</span>
            <span>{waitingAll.length ? `${waitingAll.length} waiting` : 'Nothing waiting'}</span>
          </button>
          {clients.map((cl) => {
            const k = card(cl.id);
            return (
              <button key={cl.id} className={`v5-client ${client === cl.id ? 'on' : ''}`} onClick={() => setClient(cl.id)}>
                <strong>{cl.name}</strong>
                <span>{k.count}</span>
                <span className={k.note.tone}>{k.note.text}</span>
              </button>
            );
          })}
        </div>
      </section>
      <div className="sales-grid">
        <section className="panel">
          <div className="panel-heading"><h3>Requests and meetings</h3></div>
          {rows.length ? (
            <div className="table-scroll">
              <table className="client-table">
                <thead>
                  <tr><th>Client</th><th>Issuer</th><th>When</th><th>Status</th><th>Priority</th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} className="clickable" onClick={r.open}>
                      <td><strong>{n.investor(r.investorId)}</strong><small>{r.kind}</small></td>
                      <td>{n.issuer(r.issuerId)}</td>
                      <td>{fmt(r.start, zone, 'EEE h:mm a')}</td>
                      <td>
                        <span className={`req-status ${r.status.tone}`}><i /><span>{r.status.text}</span></span>
                        {r.reason && <small>{r.reason}</small>}
                      </td>
                      <td>{r.priority === 'High' || r.priority === 'Urgent' ? <Badge tone="amber">{r.priority}</Badge> : <small>{r.priority}</small>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="Nothing yet for these clients" description="Use Find a time above to request meetings." />
          )}
        </section>
        <div className="sales-side">
          <section className="panel">
            <div className="panel-heading"><h3>What changed</h3></div>
            {feed.length ? (
              <ul className="sales-feed">
                {feed.map((f) => (
                  <li key={f.id} className={f.unread ? 'unread' : ''}>
                    <span>{f.text}</span>
                    <small>{fmt(f.at, zone, 'EEE h:mm a')}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted pad">No changes to your clients' meetings yet.</p>
            )}
          </section>
          <section className="panel itinerary">
            <div className="panel-heading">
              <h3>Client itinerary</h3>
              <select aria-label="Itinerary client" className="compact-select" value={itineraryFor || ''} onChange={(e) => setClient(e.target.value)}>
                {clients.map((cl) => <option key={cl.id} value={cl.id}>{cl.name}</option>)}
              </select>
            </div>
            {itineraryFor ? (
              <div className="pad">
                <p className="muted">{itinerary.length} confirmed meeting{itinerary.length === 1 ? '' : 's'} at {c.name}.</p>
                <div className="itinerary-actions">
                  <a className="audit-export" href={`/api/export?scope=investor&id=${itineraryFor}&conferenceId=${conferenceId}&format=pdf`}>PDF</a>
                  <a className="audit-export" href={`/api/export?scope=investor&id=${itineraryFor}&conferenceId=${conferenceId}&format=xlsx`}>Excel</a>
                  <button className="audit-export" onClick={copy}>{copied ? 'Copied' : 'Copy client email'}</button>
                  <button className="audit-export" onClick={() => run('exportMarkSent', { conferenceId, scope: 'investor', audienceId: itineraryFor }, 'Itinerary marked as sent.')}>Mark as sent</button>
                </div>
                <pre className="client-email" aria-label="Client email text">{emailText}</pre>
              </div>
            ) : (
              <p className="muted pad">No covered accounts.</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * What the desk is waiting on from this salesperson: a requested time that doesn't work (pick one
 * of the open times), and reschedules to check with the investor before the desk answers the issuer.
 */
function SalesAnswers({ data, conferenceId, run }: { data: AppState; conferenceId: string; run: Run }) {
  const n = names(data);
  const c = data.conferences.find((x) => x.id === conferenceId)!;
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const newTime = data.requests.filter((r) => r.conferenceId === conferenceId && r.status === 'Needs New Time' && r.salespersonId === data.user.id);
  const checks = data.actions.filter((a) => a.type === 'Sales check' && a.status === 'Open' && a.assignedTo === data.user.id);
  if (!newTime.length && !checks.length) return null;
  const go = async (type: string, payload: unknown, msg: string) => {
    setBusy(true);
    await run(type, payload, msg);
    setBusy(false);
  };
  return (
    <section aria-label="Needs your answer" className="v5-stack v5-answers">
      <div className="v5-section-head">
        <h2>Needs your answer</h2>
      </div>
      {checks.map((a) => (
        <div key={a.id} className="v5-card answer">
          <span className="v5-kind k-reschedule">Reschedule</span>
          <strong>{a.title}</strong>
          <span className="muted">{a.recommendation}</span>
          <input
            aria-label="Note for the desk"
            placeholder="Note for the desk (optional), e.g. client prefers the later time"
            value={notes[a.id] || ''}
            onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })}
          />
          <div className="row">
            <button className="v5-btn primary" disabled={busy} onClick={() => go('salesAnswer', { actionId: a.id, accept: true, note: notes[a.id] || '' }, 'Told the desk the new time works.')}>
              Works for {n.investor(a.investorId)}
            </button>
            <button className="v5-btn quiet" disabled={busy} onClick={() => go('salesAnswer', { actionId: a.id, accept: false, note: notes[a.id] || '' }, 'Told the desk the new time does not work.')}>
              Doesn’t work
            </button>
          </div>
        </div>
      ))}
      {newTime.map((r) => {
        const why = (r.notes || '').split('\n').reverse().find((l) => /doesn't work/.test(l)) || '';
        const alts = ((r as { alternativeDates?: string[] }).alternativeDates || []).filter(Boolean);
        return (
          <div key={r.id} className="v5-card answer">
            <span className="v5-kind k-new">New request</span>
            <strong>
              {n.investor(r.investorId)} × {n.issuer(r.issuerId)}: {fmt(r.start, c.timezone, 'MMM d · h:mm a')} doesn’t work
            </strong>
            {why && <span className="muted">{why}</span>}
            <div className="row">
              {alts.map((x) => (
                <button key={x} className="v5-btn primary" disabled={busy} onClick={() => go('alternative', { id: r.id, start: x }, `Asked for ${fmt(x, c.timezone, 'MMM d · h:mm a')} instead.`)}>
                  {fmt(x, c.timezone, 'MMM d · h:mm a')}
                </button>
              ))}
              <button className="v5-btn quiet" disabled={busy} onClick={() => go('cancelRequest', { id: r.id }, 'Request withdrawn.')}>
                Withdraw request
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
