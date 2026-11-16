'use client';
import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Plus, RefreshCw } from 'lucide-react';
import type { AppState } from '@/lib/types';
import { RequestDecision } from './decision';
import { EmailReview } from './review';
import { inboxItems, shortWhen, type InboxItem } from './inbox-model';
import { openWork } from './queue-model';
import { type Run } from './shared';

type Action = AppState['actions'][number];

/**
 * The inbox: everything waiting on a decision, one row per email (all of its asks together) or
 * request, with the decision itself in the pane beside it. Nothing here changes the schedule until
 * the reviewer approves.
 */
export function Inbox({
  data,
  conferenceId,
  run,
  emailId,
  proposalId,
  onSelectEmail,
  onReply,
  onOther,
  onOpenDraft,
  onAddEmail,
  onSync,
  onAllEmail,
  onDrafts,
  onList,
  filter,
  onClearFilter,
}: {
  data: AppState;
  conferenceId: string;
  run: Run;
  emailId: string | null;
  proposalId?: string | null;
  onSelectEmail: (id: string | null) => void;
  onReply: (emailId: string, extraQuestions?: string[]) => void;
  onOther: (a: Action) => void;
  onOpenDraft: (id: string) => void;
  onAddEmail: () => void;
  onSync?: () => void;
  onAllEmail: () => void;
  onDrafts: () => void;
  onList: () => void;
  /** Manager drill-down: only these items (by owner or kind). */
  filter?: { label: string; test: (a: Action) => boolean } | null;
  onClearFilter?: () => void;
}) {
  const zone = data.conferences.find((c) => c.id === conferenceId)?.timezone || 'America/New_York';
  const manager = data.user.role === 'MANAGER';
  const work = openWork(data, conferenceId);
  const all = useMemo(() => {
    const actions = [...work.triage, ...work.conference].filter((a) => !filter || filter.test(a));
    return inboxItems(data, actions, zone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, conferenceId, filter]);
  const mineCount = all.filter((i) => i.mine).length;
  // Each item has one owner. A banker sees their own; the desk's other items are one click away
  // (to cover for someone who is out), and the head of desk sees everything with its owner.
  const [scope, setScope] = useState<'mine' | 'all'>(() => (manager || filter ? 'all' : 'mine'));
  const items = scope === 'mine' ? all.filter((i) => i.mine) : all;
  const others = all.length - mineCount;
  const userName = (id: string | null) => data.users.find((u) => u.id === id)?.name || 'No owner';
  const firstName = (id: string | null) => userName(id).split(' ')[0];
  const bankers = data.users.filter((u) => u.role === 'BANKER' || u.role === 'MANAGER');
  async function reassign(item: InboxItem, to: string) {
    for (const a of item.actions) await fetch('/api/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'action', data: { id: a.id, assignedTo: to } }) });
    await run('ping', {}, `Now owned by ${userName(to)}.`);
  }
  const [requestId, setRequestId] = useState<string | null>(null);
  const selected =
    items.find((i) => (emailId ? i.email?.id === emailId : requestId ? i.request?.id === requestId : false)) || null;
  // An email opened from elsewhere (Today, a notification, the audit trail) may not be in the open list.
  const looseEmail = emailId && !selected ? data.emails.find((e) => e.id === emailId) : null;
  const pick = (item: InboxItem) => {
    if (item.kind === 'email') {
      setRequestId(null);
      onSelectEmail(item.email!.id);
    } else if (item.kind === 'request') {
      onSelectEmail(null);
      setRequestId(item.request!.id);
    } else onOther(item.actions[0]);
  };
  // Open the first item so the pane is never empty while work is waiting.
  useEffect(() => {
    if (!emailId && !requestId && items.length && window.innerWidth > 900) {
      const first = items.find((i) => i.kind !== 'other');
      if (first) pick(first);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, emailId, requestId]);
  // j / k walk the list, like a mail client.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement;
      if (ev.metaKey || ev.ctrlKey || ev.altKey || /INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable) return;
      if (ev.key !== 'j' && ev.key !== 'k') return;
      const list = items.filter((i) => i.kind !== 'other');
      const at = list.findIndex((i) => i.id === selected?.id);
      const next = list[Math.max(0, Math.min(list.length - 1, at + (ev.key === 'j' ? 1 : -1)))];
      if (next) pick(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, selected?.id]);
  const drafts = data.drafts.filter((d) => d.status === 'Draft').length;
  const email = selected?.email || looseEmail || null;

  return (
    <div className={`v5-inbox ${email || selected ? 'has-detail' : ''}`}>
      <section className="v5-inbox-list" aria-label="Inbox list">
        <div className="head">
          <h1>{manager ? 'Team inbox' : 'Inbox'}</h1>
          <span>{items.length ? `${items.length} open` : 'Clear'}</span>
        </div>
        <div className="tools">
          {!manager && !filter && scope === 'all' && (
            <button className="v5-chip" onClick={() => setScope('mine')}>
              Whole desk ✕
            </button>
          )}
          {filter && (
            <button className="v5-chip" onClick={onClearFilter}>
              {filter.label} ✕
            </button>
          )}
          <span className="grow" />
          {onSync && (
            <button className="v5-icon" onClick={onSync} aria-label="Sync Outlook" title="Sync Outlook">
              <RefreshCw size={15} />
            </button>
          )}
          <button className="v5-icon" onClick={onAddEmail} aria-label="Add an email" title="Paste or import an email">
            <Plus size={16} />
          </button>
        </div>
        <div className="rows">
          {items.map((i) => (
            <button key={i.id} className={`row ${selected?.id === i.id ? 'active' : ''}`} onClick={() => pick(i)} aria-current={selected?.id === i.id}>
              <span className={`v5-dot ${i.tone}`} />
              <span className="body">
                <span className="top">
                  <strong>{i.who}</strong>
                  <time>{scope === 'all' ? (i.owner === data.user.id ? 'You' : firstName(i.owner)) : shortWhen(i.at, data.now, zone)}</time>
                </span>
                <span className="what">{i.what}</span>
              </span>
            </button>
          ))}
          {!items.length && (
            <div className="none">
              <CheckCircle2 size={22} />
              <strong>{scope === 'mine' && all.length ? 'Nothing for you right now' : 'Inbox clear'}</strong>
              <span>New emails about your issuers appear here as they arrive.</span>
            </div>
          )}
        </div>
        {!manager && !filter && scope === 'mine' && others > 0 && (
          <button className="v5-desk" onClick={() => setScope('all')}>
            {others} more owned by teammates
          </button>
        )}
        <div className="foot">
          <button onClick={onDrafts}>Drafts{drafts ? ` ${drafts}` : ''}</button>
          <button onClick={onAllEmail}>All email</button>
          <button onClick={onList}>List view</button>
        </div>
      </section>
      <main className="v5-inbox-detail">
        {selected && !selected.email?.escalation && (
          <div className="v5-owner">
            <span>Owner</span>
            <select aria-label="Owner" value={selected.owner || ''} onChange={(e) => e.target.value && void reassign(selected, e.target.value)}>
              {!selected.owner && <option value="">No owner</option>}
              {bankers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.id === data.user.id ? `${u.name} (you)` : u.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {email ? (
          <EmailReview
            key={email.id}
            inline
            headline={selected?.headline}
            email={email}
            proposalId={proposalId}
            data={data}
            close={() => onSelectEmail(null)}
            run={run}
            onReply={onReply}
            onOpenEmail={(id) => onSelectEmail(id)}
            onOpenDrafts={onDrafts}
          />
        ) : selected?.request ? (
          <div className="v5-detail">
            <header className="v5-mail-head">
              <div className="trust ok">Request from {data.users.find((u) => u.id === selected.request!.salespersonId)?.name || 'sales'}</div>
              <h2>{selected.headline}</h2>
              <div className="meta">
                <span>{selected.sub}</span>
              </div>
            </header>
            <RequestDecision
              key={selected.request.id}
              request={selected.request}
              data={data}
              run={run}
              onDone={() => setRequestId(null)}
              onOpenDraft={onOpenDraft}
            />
          </div>
        ) : (
          <div className="v5-empty">
            <CheckCircle2 size={28} />
            <strong>{items.length ? 'Pick an item to review' : 'You are all caught up'}</strong>
            <span>Nothing changes on the schedule until you approve it.</span>
          </div>
        )}
      </main>
    </div>
  );
}
