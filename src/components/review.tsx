'use client';
import { useState } from 'react';
import type { AppState, EmailItem } from '@/lib/types';
import type { Extraction } from '@/lib/extraction';
import { overlaps } from '@/lib/scheduling';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { Badge, Field, fmt, names, Run } from './shared';
import { AlertTriangle, ArrowRight, Check, Code2, Mail, Sparkles } from 'lucide-react';
export function EmailReview({
  email,
  data,
  close,
  run,
}: {
  email: EmailItem;
  data: AppState;
  close: () => void;
  run: Run;
}) {
  const proposal = email.proposal,
    original = proposal?.extraction as unknown as Extraction;
  const [editor, setEditor] = useState(false),
    [json, setJson] = useState(JSON.stringify(original, null, 2)),
    [note, setNote] = useState(proposal?.reviewNote || ''),
    [resolved, setResolved] = useState(false),
    [replaceConfirmed, setReplaceConfirmed] = useState(false),
    [consent, setConsent] = useState(false),
    [requestId, setRequestId] = useState(''),
    [meetingId, setMeetingId] = useState(original?.meetingId || ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const n = names(data),
    c = data.conferences.find((c) => c.id === email.conferenceId),
    zone = c?.timezone || 'America/New_York';
  let e = original;
  try {
    e = JSON.parse(json);
  } catch {}
  const available = data.availability.filter(
    (a) => a.conferenceId === e?.conferenceId && a.issuerId === e?.issuerId,
  );
  const conflicts = data.meetings.filter(
    (m) =>
      m.conferenceId === e?.conferenceId &&
      m.issuerId === e?.issuerId &&
      m.status === 'Confirmed' &&
      e?.windows?.some((w) => overlaps(w, m)),
  );
  const done = proposal && !['Pending', 'Clarification requested'].includes(proposal.status);
  async function decide(decision: string) {
    if (!proposal) return;
    setError('');
    setBusy(true);
    try {
      const extraction = JSON.parse(json);
      if (
        await run(
          'review',
          {
            id: proposal.id,
            decision,
            extraction,
            note,
            uncertaintyResolved: resolved,
            replaceConfirmed,
            consent,
            requestId: requestId || undefined,
            meetingId: meetingId || undefined,
          },
          decision === 'clarify'
            ? 'Clarification draft created. No schedule changes applied.'
            : `Review ${decision === 'approve' ? 'approved' : decision === 'edit' ? 'saved' : 'rejected'}`,
        )
      )
        close();
    } catch {
      setError('Extraction JSON is invalid.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && close()}
      title="Review email & proposed changes"
      description="AI prepares the update. You make the decision."
      wide
    >
      <div className="review-grid">
        <section>
          <div className="section-eyebrow">
            <Mail size={14} /> SOURCE EMAIL
          </div>
          <div className="email-original">
            <h3>{email.subject}</h3>
            <div className="email-meta">
              <span>From</span>
              {email.sender}
              <span>To</span>
              {email.to.join(', ')}
              <span>CC</span>
              {email.cc.join(', ') || '—'}
              <span>Received</span>
              {fmt(email.receivedAt, zone)}
            </div>
            <pre>{email.body}</pre>
            <div className="email-thread">
              Thread: {email.threadId}
              <br />
              Message: {email.messageId}
            </div>
          </div>
          <h4 className="mini-title">Current approved availability</h4>
          {available.length ? (
            available.map((a) => (
              <div className="current-value" key={a.id}>
                <span>
                  {fmt(a.start, zone)} – {fmt(a.end, zone, 'h:mm a')}
                </span>
                <Badge>{a.kind}</Badge>
              </div>
            ))
          ) : (
            <p className="muted">No approved availability yet.</p>
          )}
          <h4 className="mini-title">Schedule overlap</h4>
          {conflicts.length ? (
            conflicts.map((m) => (
              <div key={m.id} className="notice warning">
                <AlertTriangle size={15} />
                <div>
                  <strong>
                    {n.investor(m.investorId)} · {fmt(m.start, zone, 'EEE h:mm a')}–
                    {fmt(m.end, zone, 'h:mm a')}
                  </strong>
                  <br />
                  Confirmed meeting. This booking is preserved when availability changes.
                </div>
              </div>
            ))
          ) : (
            <p className="muted">No confirmed meetings overlap the extracted windows.</p>
          )}
        </section>
        <section>
          <div className="section-eyebrow green">
            <Sparkles size={14} /> EXTRACTED PROPOSAL <Badge tone="green">Human review</Badge>
          </div>
          {e ? (
            <>
              <div className="proposal-summary">
                <Badge>{e.category}</Badge>
                <h3>
                  {n.issuer(e.issuerId)} <ArrowRight size={15} /> {e.operation}{' '}
                  {e.tentative ? 'tentative hold' : 'availability / meeting'}
                </h3>
                <p>
                  {n.conference(e.conferenceId)} · {zone}
                </p>
              </div>
              <div className="extracted-windows">
                {e.windows?.map((w, index) => (
                  <div key={index}>
                    <div className="flex justify-between gap-2">
                      <strong>{fmt(w.start, zone, 'EEE, MMM d')}</strong>
                      <Badge tone={w.kind === 'existingMeeting' ? 'amber' : 'green'}>
                        {w.kind === 'existingMeeting' ? 'Existing meeting' : 'Proposed window'}
                      </Badge>
                    </div>
                    <p className="time-range">
                      {fmt(w.start, zone, 'h:mm a')} – {fmt(w.end, zone, 'h:mm a')}
                    </p>
                    <blockquote>“{w.evidence}”</blockquote>
                  </div>
                ))}
              </div>
              {e.uncertainties?.length > 0 && (
                <div className="uncertainty">
                  <h4>
                    <AlertTriangle size={15} /> Needs your attention
                  </h4>
                  <ul>
                    {e.uncertainties.map((u, i) => (
                      <li key={i}>{u}</li>
                    ))}
                  </ul>
                </div>
              )}
              {!done && (
                <>
                  <Button size="sm" variant="outline" onClick={() => setEditor(!editor)}>
                    <Code2 size={14} />
                    {editor ? 'Hide structured editor' : 'Edit extracted information'}
                  </Button>
                  {editor && (
                    <Field
                      label="Structured extraction (JSON)"
                      hint="Edit associations, verified ISO timestamps, operation, and evidence. Saving creates an audited proposal revision."
                    >
                      <textarea
                        className="json-editor"
                        rows={14}
                        value={json}
                        onChange={(ev) => setJson(ev.target.value)}
                      />
                    </Field>
                  )}
                  {e.operation === 'confirm' && (
                    <Field label="Request to confirm">
                      <select value={requestId} onChange={(ev) => setRequestId(ev.target.value)}>
                        <option value="">Select verified request…</option>
                        {data.requests
                          .filter(
                            (r) =>
                              r.conferenceId === e.conferenceId &&
                              r.issuerId === e.issuerId &&
                              !['Cancelled', 'Confirmed'].includes(r.status),
                          )
                          .map((r) => (
                            <option key={r.id} value={r.id}>
                              {n.investor(r.investorId)} · {fmt(r.start, zone)}
                            </option>
                          ))}
                      </select>
                    </Field>
                  )}
                  {['cancel', 'reschedule'].includes(e.operation) && (
                    <Field label="Affected meeting">
                      <select value={meetingId} onChange={(ev) => setMeetingId(ev.target.value)}>
                        <option value="">Select verified meeting…</option>
                        {data.meetings
                          .filter(
                            (m) =>
                              m.conferenceId === e.conferenceId &&
                              m.issuerId === e.issuerId &&
                              m.status === 'Confirmed',
                          )
                          .map((m) => (
                            <option key={m.id} value={m.id}>
                              {n.investor(m.investorId)} · {fmt(m.start, zone)}
                            </option>
                          ))}
                      </select>
                    </Field>
                  )}
                  <Field label="Review notes / clarification question">
                    <textarea
                      rows={3}
                      placeholder="Document verification, or ask for exact dates and times…"
                      value={note}
                      onChange={(ev) => setNote(ev.target.value)}
                    />
                  </Field>
                  {!!e.uncertainties?.length && (
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={resolved}
                        onChange={(ev) => setResolved(ev.target.checked)}
                      />
                      I resolved the uncertainties and documented the outcome. Only explicit windows
                      will be applied.
                    </label>
                  )}
                  {e.operation === 'replace' && (
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={replaceConfirmed}
                        onChange={(ev) => setReplaceConfirmed(ev.target.checked)}
                      />
                      Explicitly replace all approved issuer availability.
                    </label>
                  )}
                  {['confirm', 'cancel', 'reschedule'].includes(e.operation) && (
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={consent}
                        onChange={(ev) => setConsent(ev.target.checked)}
                      />
                      I verified the affected meeting/request and obtained issuer approval for this
                      change.
                    </label>
                  )}
                </>
              )}
            </>
          ) : (
            <p className="muted">This email has no schedule-change proposal.</p>
          )}
          {error && <p className="error">{error}</p>}
        </section>
      </div>
      <div className="dialog-footer">
        {done ? (
          <Badge>{proposal.status}</Badge>
        ) : proposal ? (
          <>
            <Button variant="ghost" disabled={busy} onClick={() => decide('reject')}>
              Reject
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => decide('clarify')}>
              Request clarification
            </Button>
            {editor && (
              <Button variant="outline" disabled={busy} onClick={() => decide('edit')}>
                Save edits
              </Button>
            )}
            <Button disabled={busy} onClick={() => decide('approve')}>
              <Check size={15} />
              Approve changes
            </Button>
          </>
        ) : null}
      </div>
    </Dialog>
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
          send ? 'Delivery approved and simulated. No live email was sent.' : 'Draft saved',
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
      description="Local draft · all deliveries are simulated"
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
                  Approve simulated delivery
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
