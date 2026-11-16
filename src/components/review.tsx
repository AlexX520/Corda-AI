'use client';
import { canOperate, isDesk } from '@/lib/roles';
import { useEffect, useState } from 'react';
import type { AppState, EmailItem } from '@/lib/types';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { Sheet } from './ui/sheet';
import { EmailDecision, type Outcome } from './decision';
import { PreferenceDecision } from './preference-decision';
import { unhandledSentences } from '@/lib/review-rules';
import type { Extraction } from '@/lib/extraction-schema';
import { EventSelect } from './extraction-form';
import { Badge, Field, fmt, names, Run } from './shared';
import { actionKind, kindLabel } from './queue-model';
import { askBlocker, receivedAgo, senderCompany } from './inbox-model';
import {
  AlertTriangle,
  CalendarDays,
  Check,
  Circle,
  CircleCheck,
  Mail,
  MessageCircleQuestion,
  ShieldAlert,
} from 'lucide-react';
import { findSensitive, outsideAllowlist, stripSensitiveQuotes } from '@/lib/outbound';

const ASK_DONE = ['Approved', 'Rejected', 'Acknowledged', 'Resolved', 'Expired'];
const askState = (status: string) =>
  ASK_DONE.includes(status)
    ? { icon: <CircleCheck size={15} />, tone: 'done', text: status === 'Resolved' ? 'Handled' : status }
    : status === 'Clarification requested'
      ? { icon: <MessageCircleQuestion size={15} />, tone: 'waiting', text: 'Waiting on reply' }
      : { icon: <Circle size={15} />, tone: 'open', text: 'Needs decision' };

export function EmailReview({
  email,
  proposalId,
  data,
  close,
  run,
  onReply,
  onOpenEmail,
  inline,
  headline,
  item,
  onOpenDrafts,
}: {
  email: EmailItem;
  proposalId?: string | null;
  data: AppState;
  close: () => void;
  run: Run;
  onReply: (emailId: string, extraQuestions?: string[]) => void;
  onOpenEmail?: (id: string) => void;
  /** Render in the inbox pane instead of a side sheet. */
  inline?: boolean;
  headline?: string;
  /** From the to-do list: who (main title), what (second line), type tag, labelled meeting time. */
  item?: { who: string; what: string; type: string; typeLabel: string; when: string };
  onOpenDrafts?: () => void;
}) {
  const n = names(data);
  const asks = email.proposals;
  const firstOpen = asks.find((p) => !ASK_DONE.includes(p.status));
  const [selected, setSelected] = useState(
    // Reopening an email lands on the next open ask, not on one already decided.
    asks.find((p) => p.id === proposalId && !ASK_DONE.includes(p.status))?.id || firstOpen?.id || asks[0]?.id,
  );
  const [event, setEvent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Asks are recreated when the event is changed; fall back to the first open one.
  const proposal = asks.find((p) => p.id === selected) || firstOpen || asks[0];
  const index = proposal ? asks.indexOf(proposal) : -1;
  const issuerName = n.issuer(email.issuerId);
  const unverified = email.senderStatus === 'unverified';
  const flags = email.securityFlags.filter(
    (f) => !f.startsWith('Sender not verified') && !f.startsWith('Forwarded message is from'),
  );
  const senderFlags = email.securityFlags.filter(
    (f) => f.startsWith('Sender not verified') || f.startsWith('Forwarded message is from'),
  );
  const allPending = asks.every((p) => p.status === 'Pending');
  const ignored = ['Ignored'].includes(email.status) || !asks.length;
  const forwardedBy = email.forwardedBy
    ? data.users.find((u) => u.email?.toLowerCase() === email.forwardedBy?.toLowerCase())?.name || email.forwardedBy
    : null;
  // After one ask is decided, move on to the next open one.
  const [notify, setNotify] = useState<Outcome | null>(null);
  const next = (o?: Outcome | null) => {
    const changed = Boolean(o && ['confirmed', 'moved', 'cancelled'].includes(o.kind));
    if (changed) setNotify(o!);
    const rest = asks.filter((p) => p.id !== proposal?.id && !ASK_DONE.includes(p.status));
    if (rest.length) setSelected(rest[0].id);
    else if (!changed) close();
  };
  const openAsks = asks.filter((p) => p.status === 'Pending');
  const loose = unhandledSentences(
    email.newContent,
    asks.flatMap((p) => {
      const x = p.extraction as unknown as Extraction;
      return [...(x?.evidence || []), ...(x?.windows || []).map((w) => w.evidence)];
    }),
  );
  const [applyAll, setApplyAll] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [applyResult, setApplyResult] = useState<string[] | null>(null);
  async function approveAll() {
    setBusy(true);
    const out: string[] = [];
    for (const p of openAsks) {
      const e = p.extraction as unknown as Extraction;
      const openReq = data.requests.find((r) => !['Confirmed', 'Cancelled', 'Expired'].includes(r.status) && r.issuerId === e.issuerId && r.investorId === e.investorId);
      const r = await fetch('/api/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'review',
          data: {
            id: p.id, decision: 'approve', extraction: e, note: `Approved with all asks of this email; both sides agreed.${e.meetingId ? ' Verified affected meeting.' : ''}`,
            consent: true, confirmNow: e.category === 'New Meeting Request', consentParties: ['issuer', 'investor'],
            meetingId: e.meetingId || undefined, requestId: e.category === 'New Meeting Request' ? openReq?.id : undefined,
            // Only "verify the meeting" is resolved by this summary; real open questions still block.
            uncertaintyResolved: e.uncertainties.every((u) => u.startsWith('Select and verify')),
          },
        }),
      });
      const j = await r.json();
      out.push(`${p.summary || 'Ask'}: ${r.ok ? j.result?.outcome?.text || 'done' : `not applied — ${j.error}`}`);
    }
    setApplyResult(out);
    setBusy(false);
    await run('ping', {}, `${out.filter((x) => !x.includes('not applied')).length} of ${openAsks.length} asks applied.`);
  }
  // Inline pane: one check line per open ask, so the card shows what would block it before anyone clicks.
  type Check = { hard: string[]; soft: string[]; hold: string | null; protected: string | null; stale: string | null };
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const pendingKey = asks.filter((p) => p.status === 'Pending').map((p) => p.id + p.updatedAt).join(',');
  useEffect(() => {
    if (!inline || !isDesk(data.user.role)) return;
    let off = false;
    void Promise.all(
      asks
        .filter((p) => p.status === 'Pending')
        .map(async (p) => {
          const e = p.extraction as unknown as Extraction;
          const r = await fetch('/api/commands', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'reviewCheck', data: { id: p.id, meetingId: e?.meetingId || undefined } }),
          });
          return [p.id, r.ok ? (await r.json()).result : null] as const;
        }),
    ).then((rows) => {
      if (!off) setChecks(Object.fromEntries(rows.filter((x) => x[1])));
    });
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inline, pendingKey]);
  const zone = data.conferences.find((c) => c.id === email.conferenceId)?.timezone || 'America/New_York';
  const checkLine = (p: (typeof asks)[number]) => {
    if (ASK_DONE.includes(p.status)) return { text: p.status === 'Resolved' ? 'Handled' : p.status, tone: 'done' };
    const block = askBlocker(p, email);
    if (block) return { text: block, tone: 'warn' };
    const k = checks[p.id];
    if (!k) return { text: 'Checking…', tone: 'quiet' };
    if (k.hold) return { text: `On hold: ${k.hold}`, tone: 'bad' };
    if (k.protected) return { text: `Protected: ${k.protected}`, tone: 'bad' };
    if (k.hard.length) return { text: k.hard[0], tone: 'bad' };
    if (k.stale) return { text: `Meeting changed since this email: ${k.stale}`, tone: 'warn' };
    if (k.soft.length) return { text: k.soft[0], tone: 'warn' };
    return { text: 'Checks pass', tone: 'ok' };
  };
  const fromTo = (p: (typeof asks)[number]) => {
    const e = p.extraction as unknown as Extraction;
    const target = e?.windows?.find((w) => w.kind === 'availability');
    const t = (v: string) => fmt(v, zone, 'EEE h:mm a');
    if (e?.operation === 'cancel') return { from: e.referenceTime ? t(e.referenceTime) : '', to: 'Cancelled', strike: true, bad: true };
    if (e?.operation === 'reschedule') return { from: e.referenceTime ? t(e.referenceTime) : '', to: target ? t(target.start) : 'New time?', strike: false, bad: false };
    if (e?.category === 'New Meeting Request' || e?.operation === 'confirm') return { from: e.operation === 'confirm' ? 'Requested' : 'New', to: target ? t(target.start) : 'Time?', strike: false, bad: false };
    if (e?.operation === 'add' || e?.operation === 'replace') return { from: 'Availability', to: target ? `${fmt(target.start, zone, 'EEE h:mm')}–${fmt(target.end, zone, 'h:mm a')}` : '', strike: false, bad: false };
    return { from: '', to: '', strike: false, bad: false };
  };
  const sender = email.originalSenderName || email.originalSender || email.sender;
  const company = senderCompany(email, data) || '';
  const trust =
    email.status === 'Quarantined'
      ? { tone: 'bad', text: 'Reported as phishing' }
      : unverified || senderFlags.length
        ? { tone: 'bad', text: 'Sender not verified' }
        : email.senderStatus === 'internal'
          ? { tone: 'ok', text: `Internal${forwardedBy ? ` · forwarded by ${String(forwardedBy)}` : ''}` }
          : { tone: 'ok', text: `Verified sender${company ? ` · ${company}` : ''}` };
  const canApplyAll = openAsks.length > 1 && !email.suspicious && !email.escalation;
  const content = (
    <>
      {notify && (
        <div className="notify-banner">
          <strong>{notify.text}</strong>
          <span>Notify both sides?</span>
          <Button size="sm" onClick={() => onReply(email.id)}>
            <Mail size={13} /> Draft the reply
          </Button>
          <button className="text-button" onClick={() => setNotify(null)}>Not now</button>
        </div>
      )}
      {!inline && (openAsks.length > 1 || applyResult) && !email.suspicious && !email.escalation && (
        <div className="apply-all">
          {applyResult && !openAsks.length ? (
            <>
              <strong>Applied</strong>
              <ul className="apply-result">{applyResult.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </>
          ) : !applyAll ? (
            <button className="text-button" onClick={() => setApplyAll(true)}>
              Approve all {openAsks.length} asks…
            </button>
          ) : (
            <>
              <strong>Apply all {openAsks.length} asks</strong>
              <ol>{openAsks.map((p) => <li key={p.id}>{p.summary}</li>)}</ol>
              <label className="check">
                <input type="checkbox" checked={agreed} onChange={(ev) => setAgreed(ev.target.checked)} />
                <span>Both sides agreed to these changes</span>
              </label>
              <div className="dc-actions">
                <Button size="sm" disabled={!agreed || busy} onClick={approveAll}>Yes, apply all {openAsks.length}</Button>
                <button className="text-button" onClick={() => setApplyAll(false)}>Cancel</button>
              </div>
              {applyResult && <ul className="apply-result">{applyResult.map((x, i) => <li key={i}>{x}</li>)}</ul>}
            </>
          )}
        </div>
      )}
      {!inline && <div className="email-head">
        <div>
          <strong>{email.originalSenderName || email.originalSender || email.sender}</strong>
          {email.originalSender && <span> &lt;{email.originalSender}&gt;</span>}
          {forwardedBy && <span className="fwd-by"> · forwarded by {String(forwardedBy)}</span>}
          <small>
            {email.subject} · {fmt(email.receivedAt, undefined, 'EEE MMM d, h:mm a')}
          </small>
        </div>
        {!ignored && !email.suspicious && email.status !== 'Quarantined' && (
          <Button size="sm" variant="outline" onClick={() => onReply(email.id)}>
            <Mail size={13} /> Reply
          </Button>
        )}
      </div>}
      {email.status === 'Quarantined' && (
        <div className="sender-alert" role="alert">
          <ShieldAlert size={18} />
          <div>
            <strong>Reported as phishing</strong>
            <p>Nothing from this email was applied. Do not reply or open its links.</p>
          </div>
        </div>
      )}
      {(unverified || senderFlags.length > 0) && email.status !== 'Quarantined' && (
        <div className="sender-alert" role="alert">
          <ShieldAlert size={18} />
          <div>
            <strong>Sender not verified</strong>
            {senderFlags.map((f) => (
              <p key={f}>{f.replace(/^Sender not verified: /, '')}</p>
            ))}
            <p>No one-click approval. Report it, or confirm with the registered contact first.</p>
          </div>
        </div>
      )}
      {flags.length > 0 && (
        <div className="flag-list" role="note">
          {flags.map((f) => (
            <span key={f}>
              <AlertTriangle size={13} /> {f}
            </span>
          ))}
        </div>
      )}
      {!inline && email.escalation && email.escalationReasons.length > 0 && (
        <div className="flag-list escalation" role="note">
          <span>
            <AlertTriangle size={13} /> Escalation: {email.escalationReasons.join(' · ')}
          </span>
        </div>
      )}
      {ignored && (
        <div className="context-note missing">
          <CalendarDays size={14} />
          <span>Corda filed this as not about a conference.</span>
          <Button
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await run('reassignEmail', { emailId: email.id, treatAsConference: true }, 'Treated as a conference email and read again.');
              setBusy(false);
            }}
          >
            Treat as conference email
          </Button>
        </div>
      )}
      {!ignored && (email.contextNote || !email.conferenceId) && (
        <div className={`context-note ${email.conferenceId ? '' : 'missing'}`}>
          <CalendarDays size={14} />
          {email.conferenceId ? (
            <span>{email.contextNote}</span>
          ) : (
            <>
              <span>
                <strong>Which event?</strong> The email doesn’t name one, so it is in Needs triage.
              </span>
              {allPending && (
                <span className="context-pick">
                  <EventSelect value={event} data={data} onChange={setEvent} />
                  <Button
                    size="sm"
                    disabled={!event || busy}
                    onClick={async () => {
                      setBusy(true);
                      await run('reassignEmail', { emailId: email.id, conferenceId: event }, 'Event set. The email was re-read for that event.');
                      setBusy(false);
                    }}
                  >
                    Use this event
                  </Button>
                </span>
              )}
            </>
          )}
        </div>
      )}
      {!inline && asks.length > 1 && (
        <div className="ask-list" aria-label="Asks in this email">
          <div className="ask-list-head">
            <strong>
              Ask {index + 1} of {asks.length}
            </strong>
            <span>{asks.filter((p) => ASK_DONE.includes(p.status)).length} done</span>
          </div>
          {asks.map((p, i) => {
            const st = askState(p.status);
            return (
              <button
                key={p.id}
                className={`ask-item ${p.id === proposal?.id ? 'active' : ''} ${st.tone}`}
                onClick={() => setSelected(p.id)}
                aria-current={p.id === proposal?.id}
              >
                {st.icon}
                <span className="ask-n">{i + 1}</span>
                <span className="ask-summary">{p.summary || `Ask ${i + 1}`}</span>
                <small>{st.text}</small>
              </button>
            );
          })}
        </div>
      )}
      {inline && asks.length > 1 && (
        <section className="v5-card v5-changes" aria-label="Changes in this email">
          {asks.map((p, i) => {
            const k = checkLine(p);
            const ft = fromTo(p);
            return (
              <button key={p.id} className={`row ${p.id === proposal?.id ? 'active' : ''} ${ASK_DONE.includes(p.status) ? 'done' : ''}`} onClick={() => setSelected(p.id)} aria-current={p.id === proposal?.id}>
                <span className="n">{ASK_DONE.includes(p.status) ? <Check size={13} strokeWidth={2.6} /> : i + 1}</span>
                <span className="body">
                  <strong>
                    {(() => {
                      const act = data.actions.find((x) => x.proposalId === p.id);
                      const k = act ? actionKind(act, data).id : null;
                      return k && k !== 'other' ? <span className={`v5-kind k-${k}`}>{kindLabel[k]}</span> : null;
                    })()}
                    {p.summary || `Change ${i + 1}`}
                  </strong>
                  <small className={k.tone}>{k.text}</small>
                </span>
                {ft.to && (
                  <span className="ft">
                    {ft.from && <span className={ft.strike ? 'from strike' : 'from'}>{ft.from}</span>}
                    {ft.from && <span className="arrow" aria-hidden>→</span>}
                    <span className={ft.bad ? 'to bad' : 'to'}>{ft.to}</span>
                  </span>
                )}
              </button>
            );
          })}
          {(canApplyAll || applyResult) && (
            <div className="foot">
              {applyResult && !openAsks.length ? (
                <>
                  <ul className="apply-result">{applyResult.map((r, i) => <li key={i}>{r}</li>)}</ul>
                  <span className="grow" />
                  {onOpenDrafts && (
                    <button className="v5-btn quiet" onClick={onOpenDrafts}>
                      Review the replies
                    </button>
                  )}
                </>
              ) : (
                <>
                  <label className="agree">
                    <input type="checkbox" checked={agreed} onChange={(ev) => setAgreed(ev.target.checked)} />
                    Both sides agreed to these changes
                  </label>
                  <span className="grow" />
                  <button className="v5-btn primary" disabled={!agreed || busy} onClick={approveAll}>
                    {busy ? 'Applying…' : `Apply all ${openAsks.length}`}
                  </button>
                </>
              )}
            </div>
          )}
          {applyResult && openAsks.length > 0 && <ul className="apply-result pad">{applyResult.map((r, i) => <li key={i}>{r}</li>)}</ul>}
        </section>
      )}
      {inline && asks.length > 1 && proposal && openAsks.length > 0 && (
        <h3 className="v5-sub">
          Change {index + 1} of {asks.length} in detail
        </h3>
      )}
      {!ignored && !email.suspicious && loose.length > 0 && isDesk(data.user.role) && (
        <div className="loose-sentences">
          <span className="dc-label">Not covered by an ask</span>
          {loose.map((x) => (
            <div key={x.text} className={x.question ? 'question' : ''}>
              <span>{x.question ? '❓ ' : ''}“{x.text}”</span>
              <div className="dc-actions">
                <button className="text-button" disabled={busy} onClick={() => run('addAsk', { emailId: email.id, text: x.text }, 'Added as an ask.')}>
                  Add as ask
                </button>
                <button className="text-button" onClick={() => onReply(email.id, [x.text])}>
                  Add as question to reply
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {inline && asks.length > 1 && !openAsks.length ? null : proposal && (proposal.extraction as unknown as Extraction)?.preferences?.length ? (
        <PreferenceDecision key={proposal.id + proposal.updatedAt} email={email} proposal={proposal} data={data} run={run} onDone={next} />
      ) : proposal ? (
        <EmailDecision
          key={proposal.id + proposal.updatedAt}
          email={email}
          proposal={proposal}
          data={data}
          run={run}
          onDone={next}
          onReply={() => onReply(email.id)}
          onOpenEmail={onOpenEmail}
        />
      ) : (
        <div className="decision-card">
          <h2>{email.subject}</h2>
          <p className="dc-text">This email has no schedule change.</p>
          <pre className="dc-email-body">{email.body}</pre>
        </div>
      )}
    </>
  );
  if (inline)
    return (
      <div className={`v5-detail ${asks.length === 1 && !ignored ? 'single' : ''}`}>
        <header className="v5-mail-head">
          <div className={`trust ${trust.tone}`}>
            {trust.tone === 'ok' ? <Check size={14} strokeWidth={2.4} /> : <ShieldAlert size={14} />}
            {trust.text}
          </div>
          {item ? (
            <>
              <span className={`v5-kind k-${item.type} big`}>{item.typeLabel}</span>
              <h2>{item.who}</h2>
              <p className="what">{item.what}</p>
            </>
          ) : (
            <h2>{headline || (asks.length > 1 ? `${company || 'The sender'} sent ${asks.length} changes` : asks[0]?.summary || email.subject)}</h2>
          )}
          <div className="meta">
            {item?.when && <strong className="when">{item.when}</strong>}
            <span>
              Received {receivedAgo(email.receivedAt, data.now, zone)} from {sender}
              {email.cc.length ? ` · cc ${email.cc.length}` : ''}
            </span>
            {!ignored && !email.suspicious && email.status !== 'Quarantined' && (
              <button className="v5-link" onClick={() => onReply(email.id)}>
                Reply
              </button>
            )}
          </div>
        </header>
        {content}
      </div>
    );
  return (
    <Sheet
      open
      onOpenChange={(v) => !v && close()}
      title={issuerName === 'Unassociated' ? 'Email review' : `${issuerName} · email review`}
      description={
        asks.length > 1
          ? `${asks.length} asks in this email. Nothing updates until you approve each one.`
          : 'Corda prepared the change. Nothing updates until you approve.'
      }
    >
      {content}
    </Sheet>
  );
}

export type Compose = {
  emailId: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  allowedDomains: string[];
  questionAskIds: string[];
  kind: string;
};

/**
 * Review and send a communication. With `compose`, nothing exists yet: Save creates the draft
 * (one per email) and only then are the asks marked "waiting on reply".
 */
export function DraftEditor({
  draft,
  compose,
  data,
  close,
  run,
}: {
  draft?: AppState['drafts'][number];
  compose?: Compose;
  data: AppState;
  close: () => void;
  run: Run;
}) {
  const src = draft || compose!;
  const [to, setTo] = useState(src.to.join(', ')),
    [cc, setCc] = useState(src.cc.join(', ')),
    [subject, setSubject] = useState(src.subject),
    [body, setBody] = useState(src.body),
    [approved, setApproved] = useState(false),
    [outsideOk, setOutsideOk] = useState(false),
    [sensitiveOk, setSensitiveOk] = useState(false),
    [sensitiveReason, setSensitiveReason] = useState(''),
    [holdOverride, setHoldOverride] = useState(''),
    [busy, setBusy] = useState(false);
  const meeting = draft ? data.meetings.find((m) => m.id === draft.meetingId) : undefined;
  const live = Boolean(data.outlook?.connected);
  const readonly = Boolean(draft && draft.status !== 'Draft');
  const list = (v: string) =>
    v
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  const allowed = (draft?.allowedDomains?.length ? draft.allowedDomains : compose?.allowedDomains) || data.allowedDomains;
  const outside = outsideAllowlist([...list(to), ...list(cc)], allowed);
  const sensitive = findSensitive(`${subject}\n${body}`);
  const emailId = draft?.emailId || compose?.emailId;
  const issuerId = meeting?.issuerId || data.emails.find((e) => e.id === emailId)?.issuerId;
  const issuer = data.issuers.find((i) => i.id === issuerId) as (AppState['issuers'][number] & { holdChanges?: boolean; holdReason?: string }) | undefined;
  const onHold = Boolean(issuer?.holdChanges);
  const historical = draft?.historicalParticipants || [];
  async function save(send: boolean) {
    setBusy(true);
    try {
      let id = draft?.id;
      if (!id) {
        // Compose: the draft is created only now.
        const r = await fetch('/api/commands', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'replySave',
            data: { emailId: compose!.emailId, to: list(to), cc: list(cc), subject, body, askIds: compose!.questionAskIds },
          }),
        });
        const out = await r.json();
        if (!r.ok) throw new Error(out.error);
        id = out.result.id;
        if (!send) {
          await run('notificationsRead', {}, 'Reply saved as a draft.');
          close();
          return;
        }
      }
      if (
        await run(
          'draft',
          {
            id,
            to: list(to),
            cc: list(cc),
            subject,
            body,
            send,
            recipientsApproved: approved,
            outsideConfirmed: outsideOk,
            sensitiveConfirmed: sensitiveOk,
            sensitiveReason,
            holdOverride: holdOverride || undefined,
          },
          send
            ? live
              ? `Sent from ${data.outlook?.email} through Outlook.`
              : 'Delivery approved and simulated. No live email was sent.'
            : 'Draft saved',
        )
      )
        close();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Could not save the reply');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && close()}
      title={compose ? (compose.kind === 'escalation' ? 'Reply to the escalation' : 'Reply') : 'Review communication'}
      description={live ? `Sends from ${data.outlook?.email} via Outlook` : 'Delivery is simulated until Outlook is connected'}
    >
      <div className="form-grid">
        {draft ? <Badge>{draft.status}</Badge> : <Badge tone="blue">Not saved yet</Badge>}
        {onHold && !readonly && (
          <div className="hold-banner">
            <strong>All changes for {issuer?.name} are on hold</strong>
            <span>{issuer?.holdReason}</span>
            <input className="dc-input" placeholder="Override reason (required to send)" value={holdOverride} onChange={(e) => setHoldOverride(e.target.value)} />
          </div>
        )}
        <Field label="To" hint="Comma-separated. Thread and meeting parties are pre-approved; anyone else needs a second confirmation.">
          <input value={to} disabled={readonly} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="CC">
          <input value={cc} disabled={readonly} onChange={(e) => setCc(e.target.value)} />
        </Field>
        {historical.length > 0 && !readonly && (
          <div className="notice">
            <strong>Others on the thread</strong>
            <div className="contact-list">
              {historical.map((p) => (
                <button key={p} onClick={() => setTo([...new Set([...list(to), p])].join(', '))}>
                  {p} +
                </button>
              ))}
            </div>
          </div>
        )}
        <Field label="Subject">
          <input value={subject} disabled={readonly} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="Message">
          <textarea rows={11} value={body} disabled={readonly} onChange={(e) => setBody(e.target.value)} />
        </Field>
        {!readonly && outside.length > 0 && (
          <div className="notice warning">
            <strong>Not a party to this thread</strong>
            <p>
              {outside.join(', ')} {outside.length === 1 ? 'is' : 'are'} outside the parties on this thread/meeting and the
              bank. Check the address before sending.
            </p>
            <label className="check">
              <input type="checkbox" checked={outsideOk} onChange={(e) => setOutsideOk(e.target.checked)} />
              <span>I confirm {outside.length === 1 ? 'this recipient is' : 'these recipients are'} correct.</span>
            </label>
          </div>
        )}
        {!readonly && sensitive.length > 0 && (
          <div className="notice danger">
            <strong>Possible deal / MNPI terms</strong>
            <p>The message contains: {sensitive.join(', ')}. Client emails must not carry deal information.</p>
            <Button size="sm" variant="outline" onClick={() => setBody(stripSensitiveQuotes(body).text)}>
              Remove quoted sensitive text
            </Button>
            <label className="check">
              <input type="checkbox" checked={sensitiveOk} onChange={(e) => setSensitiveOk(e.target.checked)} />
              <span>Compliance-approved; send as written</span>
            </label>
            {sensitiveOk && (
              <input className="dc-input" placeholder="Who approved it and why (recorded in the audit trail)" value={sensitiveReason} onChange={(e) => setSensitiveReason(e.target.value)} />
            )}
          </div>
        )}
        {meeting && (
          <div className="attachment-preview">
            <strong>Attachment preview · this meeting only</strong>
            <p>
              {names(data).issuer(meeting.issuerId)} × {names(data).investor(meeting.investorId)}
            </p>
            <p>
              {fmt(meeting.start, data.conferences.find((c) => c.id === meeting.conferenceId)?.timezone)} ·{' '}
              {meeting.location || 'Location to be confirmed'}
            </p>
          </div>
        )}
        {!readonly && (
          <>
            <label className="check">
              <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} />
              <span>I reviewed the recipients, content, and attachment audience.</span>
            </label>
            <div className="flex justify-end gap-3">
              <Button disabled={busy} variant="outline" onClick={() => save(false)}>
                {compose ? 'Save draft' : 'Save draft'}
              </Button>
              {canOperate(data.user) && (
                <Button
                  disabled={
                    busy ||
                    !approved ||
                    (outside.length > 0 && !outsideOk) ||
                    (sensitive.length > 0 && (!sensitiveOk || sensitiveReason.trim().length < 5)) ||
                    (onHold && holdOverride.trim().length < 5)
                  }
                  onClick={() => save(true)}
                >
                  {live ? 'Send via Outlook' : 'Approve simulated delivery'}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
