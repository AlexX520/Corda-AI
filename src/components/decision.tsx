'use client';
import { useEffect, useState } from 'react';
import type { AppState, EmailItem, RequestItem } from '@/lib/types';
import type { Extraction } from '@/lib/extraction-schema';
import { duplicatesFor, findCandidates, isOpenMeeting, isOpenRequest, windowLabel } from '@/lib/review-rules';
import { ExtractionForm } from './extraction-form';
import { AlertTriangle, ArrowRight, Check, ChevronDown, Mail } from 'lucide-react';
import { Button } from './ui/button';
import { fmt, names, Run } from './shared';

type Action = AppState['actions'][number];

/** Generic uncertainty the parser adds when it could not pick the meeting/request itself.
 *  Picking it in the card resolves it, so it is not shown as a separate warning. */
const SELECT_UNCERTAINTY = 'Select and verify the existing meeting or request';
const realUncertainties = (e?: Extraction | null) =>
  (e?.uncertainties || []).filter((u) => !u.startsWith(SELECT_UNCERTAINTY));

type DraftRow = AppState['drafts'][number];
async function newestDraft(match: (d: DraftRow) => boolean) {
  try {
    const s = (await (await fetch('/api/state', { cache: 'no-store' })).json()) as AppState;
    return s.drafts
      .filter((d) => d.status === 'Draft' && match(d))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  } catch {
    return undefined;
  }
}

type ProposalItem = EmailItem['proposals'][number];
const DONE = ['Approved', 'Rejected', 'Acknowledged', 'Resolved'];

export function EmailDecision({
  email,
  proposal,
  data,
  run,
  onDone,
  onOpenDraft,
}: {
  email: EmailItem;
  proposal: ProposalItem;
  data: AppState;
  run: Run;
  onDone: () => void;
  onOpenDraft: (id: string) => void;
}) {
  const n = names(data);
  const original = proposal.extraction as unknown as Extraction;
  const [e, setE] = useState<Extraction>(original);
  const dirty = JSON.stringify(e) !== JSON.stringify(original);
  const zone = data.conferences.find((c) => c.id === e.conferenceId)?.timezone || 'America/New_York';
  const [showEmail, setShowEmail] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState(proposal.reviewNote || '');
  const [trustReason, setTrustReason] = useState('');
  const [extraMeeting, setExtraMeeting] = useState(false);
  const [busy, setBusy] = useState(false);
  const action = data.actions.find((a) => a.proposalId === proposal.id);
  const [owner, setOwner] = useState(action?.assignedTo || data.user.id);
  const op = e.operation;
  const unverified = email.senderStatus === 'unverified';
  const escalation = e.category === 'Escalation / complaint';
  const needsMeeting = ['cancel', 'reschedule'].includes(op);
  const needsRequest = op === 'confirm';
  const meetingPick = findCandidates(e, data.meetings, { zone, trusted: !unverified, open: isOpenMeeting, n });
  const requestPick = findCandidates(e, data.requests, { zone, trusted: !unverified, open: isOpenRequest, n, noun: 'request' });
  const [meetingId, setMeetingId] = useState(meetingPick.preselectId || '');
  const [requestId, setRequestId] = useState(requestPick.preselectId || '');
  // A pick that no longer fits the edited issuer/investor is dropped.
  useEffect(() => {
    if (meetingId && !meetingPick.candidates.some((c) => c.item.id === meetingId)) setMeetingId('');
    if (requestId && !requestPick.candidates.some((c) => c.item.id === requestId)) setRequestId('');
  }, [meetingId, requestId, meetingPick.candidates, requestPick.candidates]);
  const meeting = data.meetings.find((m) => m.id === meetingId);
  const req = data.requests.find((r) => r.id === requestId);
  const issues = realUncertainties(e);
  const hasSelectUncertainty = (e.uncertainties || []).some((u) => u.startsWith(SELECT_UNCERTAINTY));
  const dupes = e.category === 'New Meeting Request' ? duplicatesFor(e, data.meetings, data.requests) : [];
  const waiting = proposal.status === 'Clarification requested';
  const done = DONE.includes(proposal.status);
  const draft = data.drafts.find((d) => d.emailId === email.id && d.status === 'Draft');
  const [openNewDraft, setOpenNewDraft] = useState(false);
  useEffect(() => {
    if (openNewDraft && draft) {
      setOpenNewDraft(false);
      onOpenDraft(draft.id);
    }
  }, [openNewDraft, draft, onOpenDraft]);
  const newWindows = e.windows.filter((w) => w.kind === 'availability');
  const blockedWindows = e.windows.filter((w) => w.kind === 'unavailable');
  const current = data.availability.filter(
    (a) => a.conferenceId === e.conferenceId && a.issuerId === e.issuerId && a.kind === 'Available',
  );
  const issuer = e.issuerId ? n.issuer(e.issuerId) : 'an issuer (not named)';
  const investor = e.investorId ? n.investor(e.investorId) : meeting ? n.investor(meeting.investorId) : '';
  const quote = email.newContent.replace(/\s+/g, ' ').trim();
  // Who "Ask …" writes to: the sender's company when the sender is a registered contact.
  const senderDomain = email.sender.split('@').pop()?.toLowerCase();
  const senderIssuer = data.issuers.find((i) => 'contactEmail' in i && String(i.contactEmail).toLowerCase().endsWith(`@${senderDomain}`));
  const askLabel = email.senderStatus === 'internal' ? 'Ask sender' : senderIssuer ? `Ask ${senderIssuer.name}` : e.investorId && email.senderStatus === 'verified' ? `Ask ${n.investor(e.investorId)}` : 'Ask sender';

  const headline = escalation
    ? `${e.issuerId ? issuer : 'A client'} escalated${investor ? ` (${investor})` : ''}`
    : op === 'cancel'
      ? `${issuer} · cancel the ${investor || 'investor'} meeting`
      : op === 'reschedule'
        ? `${issuer} · move the ${investor || 'investor'} meeting`
        : op === 'confirm'
          ? `${issuer} confirmed the ${investor || 'investor'} meeting`
          : e.category === 'New Meeting Request'
            ? `${investor || 'An investor'} wants to meet ${issuer}`
            : ['add', 'remove', 'replace'].includes(op)
              ? `${issuer} sent availability`
              : blockedWindows.length
                ? `${issuer} said some times don’t work`
                : email.subject;

  const blockers: string[] = [];
  if (escalation) blockers.push('Escalations are acknowledged and assigned, not approved.');
  if (!e.conferenceId) blockers.push('Pick the event.');
  if (!e.issuerId) blockers.push('Pick the issuer.');
  if (needsMeeting && !meetingId) blockers.push('Pick the meeting this is about.');
  if (needsRequest && !requestId) blockers.push('Pick the request this confirms.');
  if (e.category === 'New Meeting Request' && newWindows.length !== 1) blockers.push('Needs exactly one requested time.');
  if (op === 'reschedule' && !newWindows.length) blockers.push('Needs the new time.');
  if (['add', 'remove', 'replace'].includes(op) && !newWindows.length && !blockedWindows.length)
    blockers.push('No exact times — ask the sender or add them.');
  if (dupes.length && !extraMeeting) blockers.push('Confirm this is an additional meeting.');
  if (issues.length && note.trim().length < 10) blockers.push('Note how you resolved the open questions.');
  if (dirty) blockers.push('Save your edits first.');
  const canApprove = !blockers.length;

  async function decide(decision: 'approve' | 'reject' | 'clarify' | 'edit' | 'acknowledge') {
    // The person confirms the affected meeting/request in this card; record that as the resolution.
    const autoNote =
      meeting && needsMeeting
        ? `Verified affected meeting: ${n.investor(meeting.investorId)} · ${fmt(meeting.start, zone)}`
        : req && needsRequest
          ? `Verified request: ${n.investor(req.investorId)} · ${fmt(req.start, zone)}`
          : '';
    const parts = [note.trim(), hasSelectUncertainty ? autoNote : '', unverified && trustReason.trim() ? `Sender trusted because: ${trustReason.trim()}` : ''];
    const finalNote = decision === 'approve' ? parts.filter(Boolean).join('\n') : note;
    setBusy(true);
    const ok = await run(
      'review',
      {
        id: proposal.id,
        decision,
        extraction: e,
        note: finalNote,
        uncertaintyResolved: decision === 'approve',
        replaceConfirmed: decision === 'approve' && op === 'replace',
        consent: decision === 'approve' && (needsMeeting || needsRequest),
        requestId: requestId || undefined,
        meetingId: meetingId || undefined,
        senderOverride: decision === 'approve' && unverified && trustReason.trim().length >= 10,
        duplicateConfirmed: extraMeeting,
        assignTo: decision === 'acknowledge' ? owner : undefined,
      },
      decision === 'approve'
        ? 'Approved. Schedule updated.'
        : decision === 'clarify'
          ? 'Question drafted. Nothing changed on the schedule.'
          : decision === 'reject'
            ? 'Rejected. Nothing changed on the schedule.'
            : decision === 'acknowledge'
              ? `Acknowledged. ${n.user(owner)} owns the follow-up.`
              : 'Edits saved',
    );
    setBusy(false);
    if (ok && decision === 'clarify') {
      // The conversation may leave this folder after the reload, so look the new draft up directly.
      const d = await newestDraft((x) => x.emailId === email.id);
      if (d) onOpenDraft(d.id);
      else setOpenNewDraft(true);
    } else if (ok && decision !== 'edit') onDone();
  }

  const offered = (w: Extraction['windows'][number]) =>
    `${op === 'remove' ? 'Removes ' : op === 'reschedule' ? 'Moves to ' : op === 'replace' ? 'Only ' : e.category === 'New Meeting Request' ? 'Requested ' : 'Adds '}${windowLabel(w, zone)}`;

  return (
    <section className="decision-card" aria-label="Decision">
      <span className="dc-meta">
        {escalation ? <span className="dc-urgent">Urgent</span> : null}
        {e.summary || headline}
      </span>
      <h2>{headline}</h2>

      {done && (
        <div className="dc-waiting">
          <p>
            {proposal.status === 'Acknowledged'
              ? `Acknowledged. ${n.user(action?.assignedTo || null)} owns the follow-up${action?.status === 'Resolved' ? ' (resolved).' : '.'}`
              : `Already handled: ${proposal.status.toLowerCase()}.`}
          </p>
          {proposal.status === 'Acknowledged' && action?.status === 'Open' && (
            <div className="dc-actions">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => run('action', { id: action.id, status: 'Resolved' }, 'Escalation marked resolved.').then((ok) => ok && onDone())}
              >
                <Check size={14} /> Mark resolved
              </Button>
            </div>
          )}
        </div>
      )}

      {waiting && !done ? (
        <div className="dc-waiting">
          <p>You asked the sender a question. Nothing changes on the schedule until you approve.</p>
          <div className="dc-actions">
            {draft && (
              <Button onClick={() => onOpenDraft(draft.id)}>
                <Mail size={14} /> Review question draft
              </Button>
            )}
          </div>
        </div>
      ) : null}

      {escalation ? (
        <div className="dc-escalation">
          <AlertTriangle size={16} />
          <div>
            <strong>Client escalation — a person must own this</strong>
            {e.uncertainties.map((u, i) => (
              <p key={i}>{u}</p>
            ))}
            {action?.ccUserIds?.length ? (
              <p className="muted-line">
                Routed to {n.user(action.assignedTo)} · also notified {action.ccUserIds.map(n.user).join(', ')}
              </p>
            ) : action ? (
              <p className="muted-line">Routed to {n.user(action.assignedTo)}</p>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="dc-diff">
          <div className="dc-before">
            <span className="dc-label">Now</span>
            {needsMeeting ? (
              meeting ? (
                <>
                  <s>{fmt(meeting.start, zone, 'EEE, MMM d · h:mm a')}</s>
                  <span>
                    {n.issuer(meeting.issuerId)} × {n.investor(meeting.investorId)} · {meeting.location || 'Location TBC'}
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
            ) : e.category === 'New Meeting Request' ? (
              dupes.length ? (
                dupes.map((d) => (
                  <span key={d.item.id}>
                    {d.kind === 'meeting' ? 'Meeting' : 'Request'} · {fmt(d.item.start, zone, 'EEE h:mm a')}
                  </span>
                ))
              ) : (
                <span>No meeting yet</span>
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
              newWindows.map((w, i) => <strong key={i}>{offered(w)}</strong>)
            ) : blockedWindows.length ? null : (
              <span>No exact time in the email</span>
            )}
            {e.category === 'New Meeting Request' && newWindows.length > 0 && (
              <span>
                {e.durationMinutes ? `${e.durationMinutes} min` : '30 min (default slot)'}
                {e.attendees ? ` · ${e.attendees} attendees` : ''} · request goes to {e.issuerId ? n.user(data.issuers.find((i) => i.id === e.issuerId)?.ownerId || null) : "the issuer's coverage banker"}
              </span>
            )}
            {blockedWindows.map((w, i) => (
              <strong key={`b${i}`} className="dc-blocked">
                Not available {windowLabel(w, zone)}
              </strong>
            ))}
          </div>
        </div>
      )}

      {e.vague.length > 0 && !escalation && (
        <div className="dc-note">
          <span className="dc-label">Times without an exact window (not applied)</span>
          {e.vague.map((v, i) => (
            <span key={i}>“{v}”</span>
          ))}
        </div>
      )}

      {needsMeeting && !escalation && (
        <div className="dc-pick-block">
          <label className="dc-pick">
            <span>Meeting</span>
            <select value={meetingId} onChange={(ev) => setMeetingId(ev.target.value)} disabled={done}>
              <option value="">{meetingPick.candidates.length ? 'Choose the meeting…' : 'No matching meeting'}</option>
              {meetingPick.candidates.map((c) => (
                <option key={c.item.id} value={c.item.id}>
                  {n.issuer(c.item.issuerId)} × {n.investor(c.item.investorId)} · {fmt(c.item.start, zone)}
                </option>
              ))}
            </select>
          </label>
          <p className={`dc-why ${meetingPick.preselectId ? 'ok' : ''}`}>{meetingPick.why}</p>
          {meetingId && (
            <ul className="dc-reasons">
              {meetingPick.candidates.find((c) => c.item.id === meetingId)?.reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
          )}
        </div>
      )}
      {needsRequest && !escalation && (
        <div className="dc-pick-block">
          <label className="dc-pick">
            <span>Request</span>
            <select value={requestId} onChange={(ev) => setRequestId(ev.target.value)} disabled={done}>
              <option value="">{requestPick.candidates.length ? 'Choose the request…' : 'No matching request'}</option>
              {requestPick.candidates.map((c) => (
                <option key={c.item.id} value={c.item.id}>
                  {n.investor(c.item.investorId)} · {fmt(c.item.start, zone)}
                </option>
              ))}
            </select>
          </label>
          <p className={`dc-why ${requestPick.preselectId ? 'ok' : ''}`}>{requestPick.why}</p>
        </div>
      )}

      {dupes.length > 0 && !done && (
        <div className="dc-issue">
          <AlertTriangle size={15} />
          <div>
            <strong>Possible duplicate</strong>
            {dupes.map((d) => (
              <p key={d.item.id}>
                {n.investor(d.item.investorId)} already {d.kind === 'meeting' ? 'meets' : 'has a request with'} {n.issuer(d.item.issuerId)} ·{' '}
                {fmt(d.item.start, zone, 'EEE h:mm a')} ({d.item.status.toLowerCase()})
              </p>
            ))}
            <label className="check">
              <input type="checkbox" checked={extraMeeting} onChange={(ev) => setExtraMeeting(ev.target.checked)} />
              This is an additional meeting, not a duplicate
            </label>
          </div>
        </div>
      )}

      {issues.length > 0 && !escalation && !done && (
        <div className="dc-issue">
          <AlertTriangle size={15} />
          <div>
            <strong>Open questions</strong>
            {issues.map((u, i) => (
              <p key={i}>{u}</p>
            ))}
            <input
              aria-label="How did you resolve this?"
              placeholder="If you checked with the sender, note what they said (needed to approve)"
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
            <span>
              From {email.sender} · To {email.to.join(', ')}
              {email.cc.length ? ` · Cc ${email.cc.join(', ')}` : ''}
            </span>
            <pre>{email.body}</pre>
          </div>
        )}
      </div>

      {!done && escalation && (
        <div className="dc-confirm">
          <p>Acknowledge &amp; assign one owner. Use the meeting editor for any schedule change.</p>
          <label className="dc-pick">
            <span>Owner</span>
            <select value={owner || ''} onChange={(ev) => setOwner(ev.target.value)}>
              {data.users
                .filter((u) => u.role === 'BANKER')
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                    {u.id === action?.assignedTo ? ' (addressed)' : ''}
                  </option>
                ))}
            </select>
          </label>
          <input
            className="dc-input"
            aria-label="Note for the owner"
            placeholder="Optional note for the owner (internal)"
            value={note}
            onChange={(ev) => setNote(ev.target.value)}
          />
          <div className="dc-actions">
            <Button disabled={busy || !owner} onClick={() => decide('acknowledge')}>
              <Check size={14} /> Acknowledge &amp; assign
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => decide('clarify')}>
              <Mail size={14} /> Draft a reply
            </Button>
          </div>
        </div>
      )}

      {!done && !escalation &&
        (confirming ? (
          <ConfirmStrip
            text={
              unverified
                ? 'The sender is not verified. Approve only if you confirmed this with the registered contact.'
                : needsMeeting || needsRequest
                  ? `I checked this with ${issuer} and they approved the change.`
                  : 'I checked the times against the email.'
            }
            busy={busy || (unverified && trustReason.trim().length < 10)}
            onCancel={() => setConfirming(false)}
            onConfirm={() => decide('approve')}
          >
            {unverified && (
              <input
                className="dc-input"
                aria-label="Why do you trust this email?"
                placeholder="Why do you trust this email? (e.g. confirmed by phone with Jen Walsh, Bayview IR)"
                value={trustReason}
                onChange={(ev) => setTrustReason(ev.target.value)}
              />
            )}
          </ConfirmStrip>
        ) : (
          <>
            <div className="dc-actions">
              {issues.length || unverified ? (
                <>
                  {!unverified && (
                    <Button disabled={busy} onClick={() => decide('clarify')}>
                      <Mail size={14} /> {askLabel}
                    </Button>
                  )}
                  <Button variant="outline" disabled={busy || !canApprove} onClick={() => setConfirming(true)}>
                    <Check size={14} /> {unverified ? 'Approve with a reason…' : 'Approve'}
                  </Button>
                </>
              ) : (
                <>
                  <Button disabled={busy || !canApprove} onClick={() => setConfirming(true)}>
                    <Check size={14} /> Approve
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={() => decide('clarify')}>
                    <Mail size={14} /> {askLabel}
                  </Button>
                </>
              )}
              <Button variant="ghost" disabled={busy} onClick={() => decide('reject')}>
                Reject
              </Button>
            </div>
            {!canApprove && <p className="dc-blockers">To approve: {blockers.join(' ')}</p>}
          </>
        ))}

      {!done && (
        <details className="dc-more" open={showEditor} onToggle={(ev) => setShowEditor((ev.target as HTMLDetailsElement).open)}>
          <summary>Edit what the AI extracted</summary>
          <ExtractionForm value={e} onChange={setE} data={data} />
          <div className="dc-actions">
            <Button size="sm" disabled={busy || !dirty} onClick={() => decide('edit')}>
              Save edits
            </Button>
            {dirty && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setE(original)}>
                Undo
              </Button>
            )}
          </div>
        </details>
      )}
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
          {conflict ? (
            <s>{fmt(r.start, c.timezone, 'EEE, MMM d · h:mm a')}</s>
          ) : (
            <span>{fmt(r.start, c.timezone, 'EEE, MMM d · h:mm a')}</span>
          )}
          <span>
            {r.duration} min · {conflict ? 'that time is taken' : 'open on both calendars'}
          </span>
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
            {[...r.alternatives]
              .sort((x, y) => x.start.localeCompare(y.start))
              .slice(0, 6)
              .map((s) => (
                <button
                  key={s.start}
                  disabled={busy}
                  onClick={() =>
                    go(
                      'alternative',
                      { id: r.id, start: s.start },
                      'Time updated. Confirm when the issuer agrees.',
                      false,
                    )
                  }
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
          <input
            placeholder="Optional, e.g. Ocean Tower · 201"
            value={location}
            onChange={(ev) => setLocation(ev.target.value)}
          />
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
          onConfirm={() =>
            go(
              'confirm',
              { id: r.id, location, consent: true },
              'Meeting confirmed and added to the schedule.',
            )
          }
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
              void go(
                'requestDraft',
                {
                  id: r.id,
                  purpose: conflict ? 'Alternative time proposal' : 'Availability inquiry',
                },
                'Draft ready. Review it before sending.',
                false,
              );
            }}
          >
            <Mail size={14} /> {drafts[0] ? 'Open draft to issuer' : 'Email issuer'}
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => go('cancelRequest', { id: r.id }, 'Request cancelled.')}
          >
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
  children,
}: {
  text: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="dc-confirm" role="group" aria-label="Confirm decision">
      <p>{text}</p>
      {children}
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
