'use client';
import { useState } from 'react';
import type { AppState, EmailItem } from '@/lib/types';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { Sheet } from './ui/sheet';
import { EmailDecision } from './decision';
import { EventSelect } from './extraction-form';
import { Badge, Field, fmt, names, Run } from './shared';
import { AlertTriangle, CalendarDays, Circle, CircleCheck, MessageCircleQuestion, ShieldAlert } from 'lucide-react';
import { findSensitive, outsideAllowlist, stripSensitiveQuotes } from '@/lib/outbound';
const ASK_DONE = ['Approved', 'Rejected', 'Acknowledged', 'Resolved'];
const askState = (status: string) =>
  ASK_DONE.includes(status)
    ? { icon: <CircleCheck size={15} />, tone: 'done', text: status }
    : status === 'Clarification requested'
      ? { icon: <MessageCircleQuestion size={15} />, tone: 'waiting', text: 'Waiting on reply' }
      : { icon: <Circle size={15} />, tone: 'open', text: 'Needs decision' };

export function EmailReview({
  email,
  proposalId,
  data,
  close,
  run,
  onOpenDraft,
}: {
  email: EmailItem;
  proposalId?: string | null;
  data: AppState;
  close: () => void;
  run: Run;
  onOpenDraft?: (id: string) => void;
}) {
  const n = names(data);
  const asks = email.proposals;
  const firstOpen = asks.find((p) => !ASK_DONE.includes(p.status));
  const [selected, setSelected] = useState(
    asks.find((p) => p.id === proposalId)?.id || firstOpen?.id || asks[0]?.id,
  );
  const [event, setEvent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Asks are recreated when the event is changed; fall back to the first open one.
  const proposal = asks.find((p) => p.id === selected) || firstOpen || asks[0];
  const index = proposal ? asks.indexOf(proposal) : -1;
  const issuerName = n.issuer(email.issuerId);
  const unverified = email.senderStatus === 'unverified';
  const flags = email.securityFlags.filter((f) => !f.startsWith('Sender not verified'));
  const senderFlag = email.securityFlags.find((f) => f.startsWith('Sender not verified'));
  const allPending = asks.every((p) => p.status === 'Pending');
  // After one ask is decided, move on to the next open one.
  const next = () => {
    const rest = asks.filter((p) => p.id !== proposal?.id && !ASK_DONE.includes(p.status));
    if (rest.length) setSelected(rest[0].id);
    else close();
  };
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
      {unverified && (
        <div className="sender-alert" role="alert">
          <ShieldAlert size={18} />
          <div>
            <strong>Sender not verified</strong>
            <p>{senderFlag?.replace(/^Sender not verified: /, '') || `${email.sender} is not a registered contact.`}</p>
            <p>No one-click approval. Confirm with the registered contact first; approving needs a typed reason.</p>
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
      {(email.contextNote || !email.conferenceId) && (
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
      {proposal ? (
        <EmailDecision
          key={proposal.id + proposal.updatedAt}
          email={email}
          proposal={proposal}
          data={data}
          run={run}
          onDone={next}
          onOpenDraft={(id) => {
            close();
            onOpenDraft?.(id);
          }}
        />
      ) : (
        <div className="decision-card">
          <span className="dc-meta">
            {email.sender} · {fmt(email.receivedAt, undefined, 'MMM d, h:mm a')}
          </span>
          <h2>{email.subject}</h2>
          <p className="dc-text">This email has no schedule change.</p>
          <pre className="dc-email-body">{email.body}</pre>
        </div>
      )}
    </Sheet>
  );
}
export function DraftEditor({
  draft,
  data,
  close,
  run,
}: {
  draft: AppState['drafts'][number];
  data: AppState;
  close: () => void;
  run: Run;
}) {
  const [to, setTo] = useState(draft.to.join(', ')),
    [cc, setCc] = useState(draft.cc.join(', ')),
    [subject, setSubject] = useState(draft.subject),
    [body, setBody] = useState(draft.body),
    [approved, setApproved] = useState(false),
    [outsideOk, setOutsideOk] = useState(false),
    [sensitiveOk, setSensitiveOk] = useState(false),
    [busy, setBusy] = useState(false);
  const meeting = data.meetings.find((m) => m.id === draft.meetingId);
  const list = (v: string) =>
    v
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  const outside = outsideAllowlist([...list(to), ...list(cc)], data.allowedDomains);
  const sensitive = findSensitive(`${subject}\n${body}`);
  const live = Boolean(data.outlook?.connected);
  const readonly = draft.status !== 'Draft';
  async function save(send: boolean) {
    setBusy(true);
    try {
      if (
        await run(
          'draft',
          {
            id: draft.id,
            to: to
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
            cc: cc
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
            subject,
            body,
            send,
            recipientsApproved: approved,
            outsideConfirmed: outsideOk,
            sensitiveConfirmed: sensitiveOk,
          },
          send
            ? live
              ? `Sent from ${data.outlook?.email} through Outlook.`
              : 'Delivery approved and simulated. No live email was sent.'
            : 'Draft saved',
        )
      )
        close();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && close()}
      title="Review communication"
      description={live ? `Sends from ${data.outlook?.email} via Outlook` : 'Local draft · delivery is simulated until Outlook is connected'}
    >
      <div className="form-grid">
        <Badge>{draft.status}</Badge>
        <div className="muted">From: {draft.sender}</div>
        <Field
          label="To"
          hint="Comma-separated recipients. For meeting attachments, use the issuer/investor contact or an internal banker."
        >
          <input value={to} disabled={readonly} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="CC">
          <input value={cc} disabled={readonly} onChange={(e) => setCc(e.target.value)} />
        </Field>
        {draft.historicalParticipants.length > 0 && (
          <div className="notice">
            <strong>Contacts to review</strong>
            <p>
              Historical participants are suggestions only. Click a contact to add them
              deliberately.
            </p>
            <div className="contact-list">
              {draft.historicalParticipants.map((p) => (
                <button
                  disabled={readonly}
                  key={p}
                  onClick={() =>
                    setTo(
                      [
                        ...new Set([
                          ...to
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean),
                          p,
                        ]),
                      ].join(', '),
                    )
                  }
                >
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
          <textarea
            rows={10}
            value={body}
            disabled={readonly}
            onChange={(e) => setBody(e.target.value)}
          />
        </Field>
        {!readonly && outside.length > 0 && (
          <div className="notice warning">
            <strong>Outside the registered domains</strong>
            <p>
              {outside.join(', ')} {outside.length === 1 ? 'is' : 'are'} not a registered issuer, investor or bank address.
              Check the address before sending.
            </p>
            <label className="check">
              <input type="checkbox" checked={outsideOk} onChange={(e) => setOutsideOk(e.target.checked)} />
              I confirm {outside.length === 1 ? 'this recipient is' : 'these recipients are'} correct.
            </label>
          </div>
        )}
        {!readonly && sensitive.length > 0 && (
          <div className="notice danger">
            <strong>Possible deal / MNPI terms</strong>
            <p>The message contains: {sensitive.join(', ')}. Client emails must not carry deal information.</p>
            <div className="flex gap-3 items-center">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const r = stripSensitiveQuotes(body);
                  setBody(r.text);
                }}
              >
                Remove quoted sensitive text
              </Button>
              <label className="check">
                <input type="checkbox" checked={sensitiveOk} onChange={(e) => setSensitiveOk(e.target.checked)} />
                Compliance-approved; send as written
              </label>
            </div>
          </div>
        )}
        {meeting && (
          <div className="attachment-preview">
            <strong>Attachment preview · this meeting only</strong>
            <p>
              {names(data).issuer(meeting.issuerId)} × {names(data).investor(meeting.investorId)}
            </p>
            <p>
              {fmt(
                meeting.start,
                data.conferences.find((c) => c.id === meeting.conferenceId)?.timezone,
              )}{' '}
              · {meeting.location || 'Location to be confirmed'}
            </p>
            <a
              href={`/api/export?conferenceId=${meeting.conferenceId}&scope=meeting&id=${meeting.id}&format=ics`}
            >
              Download calendar attachment ↗
            </a>
          </div>
        )}
        {!readonly && (
          <>
            <label className="check">
              <input
                type="checkbox"
                checked={approved}
                onChange={(e) => setApproved(e.target.checked)}
              />
              I reviewed the recipients, content, and attachment audience.
            </label>
            <div className="flex justify-end gap-3">
              <Button disabled={busy} variant="outline" onClick={() => save(false)}>
                Save draft
              </Button>
              {data.user.role === 'BANKER' && (
                <Button
                  disabled={busy || !approved || (outside.length > 0 && !outsideOk) || (sensitive.length > 0 && !sensitiveOk)}
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
