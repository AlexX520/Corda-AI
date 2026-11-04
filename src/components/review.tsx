'use client';
import { isDesk } from '@/lib/roles';
import { useState } from 'react';
import type { AppState, EmailItem } from '@/lib/types';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { Sheet } from './ui/sheet';
import { EmailDecision, type Outcome } from './decision';
import { unhandledSentences } from '@/lib/review-rules';
import type { Extraction } from '@/lib/extraction-schema';
import { EventSelect } from './extraction-form';
import { Badge, Field, fmt, names, Run } from './shared';
import {
  AlertTriangle,
  CalendarDays,
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
}: {
  email: EmailItem;
  proposalId?: string | null;
  data: AppState;
  close: () => void;
  run: Run;
  onReply: (emailId: string, extraQuestions?: string[]) => void;
  onOpenEmail?: (id: string) => void;
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
            id: p.id, decision: 'approve', extraction: e, note: 'Approved with all asks of this email; both sides agreed.',
            consent: true, confirmNow: e.category === 'New Meeting Request', consentParties: ['issuer', 'investor'],
            meetingId: e.meetingId || undefined, requestId: e.category === 'New Meeting Request' ? openReq?.id : undefined, uncertaintyResolved: false,
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
  return (
    <Sheet
      open
      onOpenChange={(v) => !v && close()}
      title={issuerName === 'Unassociated' ? 'Email review' : `${issuerName} · email review`}
      description={
        asks.length > 1
          ? `${asks.length} asks in this email. Nothing updates until you approve each one.`
          : 'AI prepared the change. Nothing updates until you approve.'
      }
    >
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
      {openAsks.length > 1 && !email.suspicious && !email.escalation && (
        <div className="apply-all">
          {!applyAll ? (
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
      <div className="email-head">
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
      </div>
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
      {email.escalation && email.escalationReasons.length > 0 && (
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
      {asks.length > 1 && (
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
      {proposal ? (
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
              {isDesk(data.user.role) && (
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
