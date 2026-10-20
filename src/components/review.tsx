'use client';
import { useState } from 'react';
import type { AppState, EmailItem } from '@/lib/types';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { Sheet } from './ui/sheet';
import { EmailDecision } from './decision';
import { Badge, Field, fmt, names, Run } from './shared';
export function EmailReview({
  email,
  data,
  close,
  run,
  onOpenDraft,
}: {
  email: EmailItem;
  data: AppState;
  close: () => void;
  run: Run;
  onOpenDraft?: (id: string) => void;
}) {
  const n = names(data);
  const done = email.proposal && !['Pending', 'Clarification requested'].includes(email.proposal.status);
  return (
    <Sheet
      open
      onOpenChange={(v) => !v && close()}
      title={n.issuer(email.issuerId) === 'Unassociated' ? 'Email review' : `${n.issuer(email.issuerId)} · email review`}
      description="AI prepared the change. Nothing updates until you approve."
    >
      {email.proposal && !done ? (
        <EmailDecision
          email={email}
          data={data}
          run={run}
          onDone={close}
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
          <p className="dc-text">
            {email.proposal ? `Already handled: ${email.proposal.status.toLowerCase()}.` : 'This email has no schedule change.'}
          </p>
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
    [busy, setBusy] = useState(false);
  const meeting = data.meetings.find((m) => m.id === draft.meetingId);
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
                <Button disabled={busy || !approved} onClick={() => save(true)}>
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
