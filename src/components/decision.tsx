'use client';
import { useEffect, useState } from 'react';
import type { AppState, EmailItem, RequestItem } from '@/lib/types';
import type { Extraction } from '@/lib/extraction';
import { AlertTriangle, ArrowRight, Check, ChevronDown, Mail } from 'lucide-react';
import { Button } from './ui/button';
import { fmt, names, Run } from './shared';

type Action = AppState['actions'][number];


/** Generic uncertainty the parser adds when it could not pick the meeting/request itself.
 *  Picking it in the card resolves it, so it is not shown as a separate warning. */
const SELECT_UNCERTAINTY = 'Select and verify the existing meeting or request';
const realUncertainties = (e?: Extraction | null) =>
  (e?.uncertainties || []).filter((u) => !u.startsWith(SELECT_UNCERTAINTY));

const verbs: Record<string, string> = {
  cancel: 'Cancel meeting',
  reschedule: 'Reschedule meeting',
  confirm: 'Confirm meeting',
  add: 'Update availability',
  remove: 'Remove availability',
  replace: 'Replace availability',
};

type DraftRow = AppState['drafts'][number];
async function newestDraft(match: (d: DraftRow) => boolean) {
  try {
    const s = (await (await fetch('/api/state', { cache: 'no-store' })).json()) as AppState;
    return s.drafts.filter((d) => d.status === 'Draft' && match(d)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  } catch {
    return undefined;
  }
}

export function describe(a: Action, data: AppState) {
  const n = names(data);
  const zone = data.conferences.find((c) => c.id === a.conferenceId)?.timezone;
  const email = data.emails.find((e) => e.id === a.emailId);
  const request = data.requests.find((r) => r.id === a.requestId);
  const e = email?.proposal?.extraction as unknown as Extraction | undefined;
  const issuer = n.issuer(a.issuerId || e?.issuerId || request?.issuerId || null);
  const investorId = a.investorId || e?.investorId || request?.investorId || null;
  const investor = investorId ? n.investor(investorId) : '';
  const who = investor && investor !== '—' ? `${issuer} · ${investor}` : issuer;
  if (email) {
    const waiting = email.proposal?.status === 'Clarification requested';
    return {
      who,
      what: waiting ? 'Waiting on issuer reply' : e ? verbs[e.operation] || e.category : email.subject,
      when: fmt(email.receivedAt, zone, 'MMM d'),
      attention: !waiting && realUncertainties(e).length > 0,
    };
  }
  if (request) {
    const conflict = ['Conflict', 'Alternative Slots Available'].includes(request.status);
    const drafted = data.drafts.some((d) => d.requestId === request.id && d.status === 'Draft');
    return {
      who,
      what: drafted ? 'Draft to issuer ready' : conflict ? 'Requested time is taken' : `Meeting request · ${fmt(request.start, zone, 'EEE h:mm a')}`,
      when: 'Request',
      attention: conflict,
    };
  }
  return {
    who: a.issuerId ? who : a.title.replace(/ · seed-[\w-]+$/, ''),
    what: a.type,
    when: '',
    attention: ['Urgent', 'High'].includes(a.priority),
  };
}

export function DecisionCard(props: {
  action: Action;
  data: AppState;
  run: Run;
  onDone: () => void;
  onOpenDraft: (id: string) => void;
  onOpenSettings: () => void;
}) {
  const { action, data } = props;
  const email = data.emails.find((e) => e.id === action.emailId);
  const request = data.requests.find((r) => r.id === action.requestId);
  if (email) return <EmailDecision email={email} {...props} />;
  if (request) return <RequestDecision request={request} {...props} />;
  return (
    <section className="decision-card">
      <span className="dc-meta">{action.type}</span>
      <h2>{action.title}</h2>
      <p className="dc-text">{action.recommendation}</p>
      <div className="dc-actions">
        <Button onClick={props.onOpenSettings}>
          Open in settings <ArrowRight size={14} />
        </Button>
        <Button
          variant="ghost"
          onClick={() =>
            props
              .run('action', { id: action.id, status: 'Resolved' }, 'Marked as done. No schedule change applied.')
              .then((ok) => ok && props.onDone())
          }
        >
          Mark done
        </Button>
      </div>
    </section>
  );
}

export function EmailDecision({
  email,
  data,
  run,
  onDone,
  onOpenDraft,
}: {
  email: EmailItem;
  data: AppState;
  run: Run;
  onDone: () => void;
  onOpenDraft: (id: string) => void;
}) {
  const n = names(data);
  const proposal = email.proposal;
  const original = proposal?.extraction as unknown as Extraction | undefined;
  const zone = data.conferences.find((c) => c.id === email.conferenceId)?.timezone || 'America/New_York';
  const [json, setJson] = useState(JSON.stringify(original, null, 2));
  const [showEmail, setShowEmail] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState(proposal?.reviewNote || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  let e = original;
  try {
    e = JSON.parse(json);
  } catch {}

  const op = e?.operation || '';
  const meetingCandidates = data.meetings.filter(
    (m) =>
      m.conferenceId === e?.conferenceId &&
      m.issuerId === e?.issuerId &&
      m.status === 'Confirmed' &&
      (!e?.investorId || m.investorId === e.investorId),
  );
  const requestCandidates = data.requests.filter(
    (r) =>
      r.conferenceId === e?.conferenceId &&
      r.issuerId === e?.issuerId &&
      !['Cancelled', 'Confirmed'].includes(r.status) &&
      (!e?.investorId || r.investorId === e.investorId),
  );
  const [meetingId, setMeetingId] = useState(
    e?.meetingId || (meetingCandidates.length === 1 ? meetingCandidates[0].id : ''),
  );
  const [requestId, setRequestId] = useState(requestCandidates.length === 1 ? requestCandidates[0].id : '');
  const meeting = data.meetings.find((m) => m.id === meetingId);
  const req = data.requests.find((r) => r.id === requestId);
  const issues = realUncertainties(e);
  const needsMeeting = ['cancel', 'reschedule'].includes(op);
  const needsRequest = op === 'confirm';
  const needsConsent = needsMeeting || needsRequest;
  const hasSelectUncertainty = (e?.uncertainties || []).some((u) => u.startsWith(SELECT_UNCERTAINTY));
  const waiting = proposal?.status === 'Clarification requested';
  const draft = data.drafts.find((d) => d.emailId === email.id && d.status === 'Draft');
  const [openNewDraft, setOpenNewDraft] = useState(false);
  useEffect(() => {
    if (openNewDraft && draft) {
      setOpenNewDraft(false);
      onOpenDraft(draft.id);
    }
  }, [openNewDraft, draft, onOpenDraft]);
  const newWindows = (e?.windows || []).filter((w) => w.kind === 'availability');
  const current = data.availability.filter(
    (a) => a.conferenceId === e?.conferenceId && a.issuerId === e?.issuerId && a.kind === 'Available',
  );
  const issuer = n.issuer(e?.issuerId || email.issuerId);
  const investor = e?.investorId ? n.investor(e.investorId) : meeting ? n.investor(meeting.investorId) : '';
  const quote = email.newContent.replace(/\s+/g, ' ').trim();

  const headline =
    op === 'cancel'
      ? `${issuer} wants to cancel the ${investor || 'investor'} meeting`
      : op === 'reschedule'
        ? `${issuer} wants to move the ${investor || 'investor'} meeting`
        : op === 'confirm'
          ? `${issuer} confirmed the ${investor || 'investor'} meeting`
          : ['add', 'remove', 'replace'].includes(op)
            ? `${issuer} sent new availability`
            : email.subject;

  const canApprove =
    !!proposal &&
    (!needsMeeting || !!meetingId) &&
    (!needsRequest || !!requestId) &&
    (!issues.length || note.trim().length >= 10);

  async function decide(decision: 'approve' | 'reject' | 'clarify' | 'edit') {
    if (!proposal) return;
    setError('');
    let extraction: Extraction;
    try {
      extraction = JSON.parse(json);
    } catch {
      setError('The edited details are not valid JSON.');
      return;
    }
    // The person confirms the affected meeting/request in this card; record that as the resolution.
    const autoNote =
      meeting && needsMeeting
        ? `Verified affected meeting: ${n.investor(meeting.investorId)} · ${fmt(meeting.start, zone)}`
        : req && needsRequest
          ? `Verified request: ${n.investor(req.investorId)} · ${fmt(req.start, zone)}`
          : '';
    const finalNote = decision === 'approve' ? [note.trim(), hasSelectUncertainty ? autoNote : ''].filter(Boolean).join('\n') : note;
    setBusy(true);
    const ok = await run(
      'review',
      {
        id: proposal.id,
        decision,
        extraction,
        note: finalNote,
        uncertaintyResolved: decision === 'approve',
        replaceConfirmed: decision === 'approve' && op === 'replace',
        consent: decision === 'approve' && needsConsent,
        requestId: requestId || undefined,
        meetingId: meetingId || undefined,
      },
      decision === 'approve'
        ? 'Approved. Schedule updated.'
        : decision === 'clarify'
          ? 'Draft ready. Nothing changed on the schedule.'
          : decision === 'reject'
            ? 'Rejected. Nothing changed on the schedule.'
            : 'Edits saved',
    );
    setBusy(false);
    if (ok && decision === 'clarify') {
      // The conversation may leave this folder after the reload, so look the new draft up directly.
      const d = await newestDraft((x) => x.emailId === email.id);
      if (d) onOpenDraft(d.id);
      else setOpenNewDraft(true);
    }
    else if (ok && decision !== 'edit') onDone();
  }

  return (
    <section className="decision-card" aria-label="Decision">
      <span className="dc-meta">
        Email · {email.sender} · {fmt(email.receivedAt, zone, 'MMM d, h:mm a')}
      </span>
      <h2>{headline}</h2>

      {waiting ? (
        <div className="dc-waiting">
          <p>You asked the issuer to clarify. Nothing changes on the schedule until you approve.</p>
          <div className="dc-actions">
            {draft && <Button onClick={() => onOpenDraft(draft.id)}><Mail size={14} /> Review draft to issuer</Button>}
            <Button variant="outline" disabled={busy} onClick={() => setConfirming(true)}>
              Approve anyway
            </Button>
          </div>
        </div>
      ) : null}

      <div className="dc-diff">
        <div className="dc-before">
          <span className="dc-label">Now</span>
          {needsMeeting ? (
            meeting ? (
              <>
                <s>{fmt(meeting.start, zone, 'EEE, MMM d · h:mm a')}</s>
                <span>
                  {issuer} × {n.investor(meeting.investorId)} · {meeting.location || 'Location TBC'}
                </span>
              </>
            ) : (
              <span>Pick the meeting below</span>
            )
          ) : needsRequest ? (
            req ? (
              <>
                <span>{fmt(req.start, zone, 'EEE, MMM d · h:mm a')}</span>
                <span>Request · {req.status}</span>
              </>
            ) : (
              <span>Pick the request below</span>
            )
          ) : current.length ? (
            current.slice(0, 3).map((a) => (
              <span key={a.id}>
                {fmt(a.start, zone, 'EEE h:mm a')} – {fmt(a.end, zone, 'h:mm a')}
              </span>
            ))
          ) : (
            <span>No availability yet</span>
          )}
        </div>
        <ArrowRight className="dc-arrow" size={18} aria-hidden="true" />
        <div className="dc-after">
          <span className="dc-label">After you approve</span>
          {op === 'cancel' ? (
            <>
              <strong>Meeting cancelled</strong>
              <span>The slot opens up again</span>
            </>
          ) : op === 'confirm' ? (
            <>
              <strong>Confirmed meeting</strong>
              <span>{req ? fmt(req.start, zone, 'EEE, MMM d · h:mm a') : '—'}</span>
            </>
          ) : newWindows.length ? (
            newWindows.map((w, i) => (
              <strong key={i}>
                {op === 'remove' ? 'Removes ' : op === 'reschedule' ? 'Moves to ' : op === 'replace' ? 'Only ' : 'Adds '}
                {fmt(w.start, zone, 'EEE h:mm a')} – {fmt(w.end, zone, 'h:mm a')}
              </strong>
            ))
          ) : (
            <span>No explicit time in the email</span>
          )}
        </div>
      </div>

      {needsMeeting && (meetingCandidates.length !== 1 || !e?.meetingId) && (
        <label className="dc-pick">
          <span>Meeting</span>
          <select value={meetingId} onChange={(ev) => setMeetingId(ev.target.value)}>
            <option value="">Choose the meeting…</option>
            {meetingCandidates.map((m) => (
              <option key={m.id} value={m.id}>
                {n.investor(m.investorId)} · {fmt(m.start, zone)}
              </option>
            ))}
          </select>
        </label>
      )}
      {needsRequest && (
        <label className="dc-pick">
          <span>Request</span>
          <select value={requestId} onChange={(ev) => setRequestId(ev.target.value)}>
            <option value="">Choose the request…</option>
            {requestCandidates.map((r) => (
              <option key={r.id} value={r.id}>
                {n.investor(r.investorId)} · {fmt(r.start, zone)}
              </option>
            ))}
          </select>
        </label>
      )}

      {issues.length > 0 && (!waiting || confirming) && (
        <div className="dc-issue">
          <AlertTriangle size={15} />
          <div>
            <strong>AI wasn't sure about this</strong>
            {issues.map((u, i) => (
              <p key={i}>{u}</p>
            ))}
            <input
              aria-label="How did you resolve this?"
              placeholder="If you checked with the issuer, note what they said (needed to approve)"
              value={note}
              onChange={(ev) => setNote(ev.target.value)}
            />
          </div>
        </div>
      )}

      <div className="dc-quote">
        <p>“{quote.length > 220 ? `${quote.slice(0, 220)}…` : quote}”</p>
        <button className="dc-link" onClick={() => setShowEmail(!showEmail)}>
          {showEmail ? 'Hide original email' : 'Show original email'} <ChevronDown size={13} />
        </button>
        {showEmail && (
          <div className="dc-email">
            <span>From {email.sender} · To {email.to.join(', ')}</span>
            <pre>{email.body}</pre>
          </div>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      {!waiting && proposal && proposal.status === 'Pending' && (
        confirming ? (
          <ConfirmStrip
            text={
              needsConsent
                ? `I checked this with ${issuer} and they approved the change.`
                : 'I checked the times against the email.'
            }
            busy={busy}
            onCancel={() => setConfirming(false)}
            onConfirm={() => decide('approve')}
          />
        ) : (
          <div className="dc-actions">
            {issues.length ? (
              <>
                <Button disabled={busy} onClick={() => decide('clarify')}>
                  <Mail size={14} /> Ask issuer
                </Button>
                <Button variant="outline" disabled={busy || !canApprove} onClick={() => setConfirming(true)}>
                  <Check size={14} /> Approve
                </Button>
              </>
            ) : (
              <>
                <Button disabled={busy || !canApprove} onClick={() => setConfirming(true)}>
                  <Check size={14} /> Approve
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => decide('clarify')}>
                  <Mail size={14} /> Ask issuer
                </Button>
              </>
            )}
            <Button variant="ghost" disabled={busy} onClick={() => decide('reject')}>
              Reject
            </Button>
          </div>
        )
      )}
      {waiting && confirming && (
        <ConfirmStrip
          text={`I checked this with ${issuer} and they approved the change.`}
          busy={busy || !canApprove}
          onCancel={() => setConfirming(false)}
          onConfirm={() => decide('approve')}
        />
      )}

      <details className="dc-more" open={showEditor} onToggle={(ev) => setShowEditor((ev.target as HTMLDetailsElement).open)}>
        <summary>Edit what the AI extracted</summary>
        <textarea rows={12} value={json} onChange={(ev) => setJson(ev.target.value)} aria-label="Extracted details (JSON)" />
        <Button size="sm" variant="outline" disabled={busy} onClick={() => decide('edit')}>
          Save edits
        </Button>
      </details>
    </section>
  );
}

export function RequestDecision({
  request: r,
  data,
  run,
  onDone,
  onOpenDraft,
}: {
  request: RequestItem;
  action?: Action;
  data: AppState;
  run: Run;
  onDone: () => void;
  onOpenDraft: (id: string) => void;
}) {
  const n = names(data);
  const c = data.conferences.find((x) => x.id === r.conferenceId)!;
  const [location, setLocation] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const conflict = ['Conflict', 'Alternative Slots Available'].includes(r.status);
  const issuer = n.issuer(r.issuerId);
  const investor = n.investor(r.investorId);
  const drafts = data.drafts
    .filter((d) => d.requestId === r.id && d.status === 'Draft')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const [openNewDraft, setOpenNewDraft] = useState(false);
  // Open the draft as soon as the one we just asked for shows up.
  useEffect(() => {
    if (openNewDraft && drafts[0]) {
      setOpenNewDraft(false);
      onOpenDraft(drafts[0].id);
    }
  }, [openNewDraft, drafts, onOpenDraft]);

  async function go(type: string, payload: unknown, msg: string, finish = true) {
    setBusy(true);
    const ok = await run(type, payload, msg);
    setBusy(false);
    if (ok && finish) onDone();
    return ok;
  }

  return (
    <section className="decision-card" aria-label="Decision">
      <span className="dc-meta">
        Meeting request · from {n.user(r.salespersonId)} · {c.name}
      </span>
      <h2>
        {investor} wants to meet {issuer}
      </h2>
      <div className="dc-diff">
        <div className="dc-before">
          <span className="dc-label">Requested</span>
          {conflict ? <s>{fmt(r.start, c.timezone, 'EEE, MMM d · h:mm a')}</s> : <span>{fmt(r.start, c.timezone, 'EEE, MMM d · h:mm a')}</span>}
          <span>{r.duration} min · {conflict ? 'that time is taken' : 'open on both calendars'}</span>
        </div>
        <ArrowRight className="dc-arrow" size={18} aria-hidden="true" />
        <div className="dc-after">
          <span className="dc-label">After you confirm</span>
          {conflict ? (
            <span>Pick an open time below</span>
          ) : (
            <>
              <strong>Confirmed meeting</strong>
              <span>
                {fmt(r.start, c.timezone, 'EEE h:mm a')} – {fmt(r.end, c.timezone, 'h:mm a')}
              </span>
            </>
          )}
        </div>
      </div>
      {conflict && r.alternatives.length > 0 && (
        <div className="dc-slots">
          <span>Open times for both sides</span>
          <div>
            {[...r.alternatives].sort((x, y) => x.start.localeCompare(y.start)).slice(0, 6).map((s) => (
              <button
                key={s.start}
                disabled={busy}
                onClick={() => go('alternative', { id: r.id, start: s.start }, 'Time updated. Confirm when the issuer agrees.', false)}
              >
                {fmt(s.start, c.timezone, 'EEE h:mm a')}
              </button>
            ))}
          </div>
        </div>
      )}
      {r.notes && <p className="dc-text">“{r.notes}”</p>}
      {!conflict && (
        <label className="dc-pick">
          <span>Room</span>
          <input placeholder="Optional, e.g. Ocean Tower · 201" value={location} onChange={(ev) => setLocation(ev.target.value)} />
        </label>
      )}
      {drafts[0] && (
        <div className="dc-draft">
          <Mail size={15} />
          <span>
            Draft to {issuer} is ready · <em>{drafts[0].subject}</em>
          </span>
        </div>
      )}
      {confirming ? (
        <ConfirmStrip
          text={`${issuer} agreed to this time.`}
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => go('confirm', { id: r.id, location, consent: true }, 'Meeting confirmed and added to the schedule.')}
        />
      ) : (
        <div className="dc-actions">
          {!conflict && (
            <Button disabled={busy} onClick={() => setConfirming(true)}>
              <Check size={14} /> Confirm meeting
            </Button>
          )}
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (drafts[0]) return onOpenDraft(drafts[0].id);
              setOpenNewDraft(true);
              void go('requestDraft', { id: r.id, purpose: conflict ? 'Alternative time proposal' : 'Availability inquiry' }, 'Draft ready. Review it before sending.', false);
            }}
          >
            <Mail size={14} /> {drafts[0] ? 'Open draft to issuer' : 'Email issuer'}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => go('cancelRequest', { id: r.id }, 'Request cancelled.')}>
            Decline
          </Button>
        </div>
      )}
    </section>
  );
}

export function ConfirmStrip({
  text,
  busy,
  onConfirm,
  onCancel,
}: {
  text: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="dc-confirm" role="group" aria-label="Confirm decision">
      <p>{text}</p>
      <div className="dc-actions">
        <Button disabled={busy} onClick={onConfirm}>
          <Check size={14} /> Yes, apply it
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Back
        </Button>
      </div>
    </div>
  );
}
