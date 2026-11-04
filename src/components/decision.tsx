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
  (e?.uncertainties || []).filter((u) => !u.startsWith(SELECT_UNCERTAINTY) && !u.startsWith('Conditional:'));

type ProposalItem = EmailItem['proposals'][number];
const DONE = ['Approved', 'Rejected', 'Acknowledged', 'Resolved'];
type Check = {
  hard: string[];
  soft: string[];
  issuerAsked: boolean;
  investorAsked: boolean;
  stale: string | null;
  hold: string | null;
  protected: string | null;
};
const MEETING_OPS = ['cancel', 'reschedule', 'update'];

export function EmailDecision({
  email,
  proposal,
  data,
  run,
  onDone,
  onReply,
  onOpenEmail,
}: {
  email: EmailItem;
  proposal: ProposalItem;
  data: AppState;
  run: Run;
  onDone: () => void;
  onReply: () => void;
  onOpenEmail?: (id: string) => void;
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
  const [conditionMet, setConditionMet] = useState(false);
  const [consent, setConsent] = useState<{ issuer: boolean; investor: boolean }>({ issuer: false, investor: false });
  const [extend, setExtend] = useState(false);
  const [holdOverride, setHoldOverride] = useState('');
  const [protectedOverride, setProtectedOverride] = useState('');
  const [holdReason, setHoldReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<Check | null>(null);
  const action = data.actions.find((a) => a.proposalId === proposal.id);
  const [owner, setOwner] = useState(action?.assignedTo || data.user.id);
  const op = e.operation;
  const unverified = email.senderStatus === 'unverified';
  const suspicious = email.suspicious;
  const escalation = e.category === 'Escalation / complaint';
  const needsMeeting = MEETING_OPS.includes(op);
  const needsRequest = op === 'confirm';
  const meetingPick = findCandidates(e, data.meetings, { zone, trusted: !suspicious, open: isOpenMeeting, n });
  const requestPick = findCandidates(e, data.requests, { zone, trusted: !suspicious, open: isOpenRequest, n, noun: 'request' });
  // "Please drop the Apollo request": a cancellation can be about an open request.
  const cancelRequest = op === 'cancel' && !meetingPick.candidates.length && requestPick.candidates.length > 0;
  const [meetingId, setMeetingId] = useState(meetingPick.preselectId || '');
  const [requestId, setRequestId] = useState(requestPick.preselectId || '');
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
  const issuerRow = data.issuers.find((i) => i.id === e.issuerId) as (AppState['issuers'][number] & { holdChanges?: boolean; holdReason?: string }) | undefined;
  // Live check of what would stop this approval: real conflicts, staleness, holds.
  const checkKey = JSON.stringify([proposal.id, e.windows, e.issuerId, e.investorId, e.operation, e.attendees, meetingId, data.meetings.find((m) => m.id === meetingId)?.version]);
  useEffect(() => {
    if (done || escalation) return;
    let live = true;
    const t = setTimeout(async () => {
      try {
        const r = await fetch('/api/commands', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'reviewCheck', data: { id: proposal.id, extraction: e, meetingId: meetingId || undefined } }),
        });
        const out = await r.json();
        if (live && r.ok) {
          setCheck(out.result);
          setConsent((c) => ({ issuer: c.issuer || out.result.issuerAsked, investor: c.investor || out.result.investorAsked }));
        }
      } catch {
        /* the approval re-checks on the server */
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkKey, done, escalation]);
  const newWindows = e.windows.filter((w) => w.kind === 'availability');
  const blockedWindows = e.windows.filter((w) => w.kind === 'unavailable');
  const current = data.availability.filter(
    (a) => a.conferenceId === e.conferenceId && a.issuerId === e.issuerId && a.kind === 'Available',
  );
  const issuer = e.issuerId ? n.issuer(e.issuerId) : 'an issuer (not named)';
  const investor = e.investorId ? n.investor(e.investorId) : meeting ? n.investor(meeting.investorId) : '';
  const quote = email.newContent.replace(/\s+/g, ' ').trim();
  // Same meeting, other emails; newer replies on this thread.
  const otherAsks = data.emails.filter((x) => x.threadId !== email.threadId).flatMap((x) =>
    x.proposals
      .filter((p) => p.id !== proposal.id && ['Pending', 'Clarification requested'].includes(p.status))
      .filter((p) => {
        const o = p.extraction as unknown as Extraction;
        return Boolean(o && ((meetingId && o.meetingId === meetingId) || (e.issuerId && e.investorId && o.issuerId === e.issuerId && o.investorId === e.investorId)));
      })
      .map((p) => ({ email: x, p })),
  );
  const newer = data.emails.filter(
    (x) => x.threadId === email.threadId && x.id !== email.id && (x.receivedAt > email.receivedAt || (x.receivedAt === email.receivedAt && x.id > email.id)),
  );
  const softOutside = (check?.soft || []).some((x) => x.startsWith('Outside'));
  // Who asked: an issuer moving its own meeting phrases it as asking the investor, and vice versa.
  const asker = email.originalSenderName || (check?.issuerAsked ? issuer : check?.investorAsked ? investor : email.sender);
  const headline = escalation
    ? `${e.issuerId ? issuer : 'A client'} escalated${investor ? ` (${investor})` : ''}`
    : op === 'cancel'
      ? `${issuer} · cancel the ${investor || 'investor'} ${cancelRequest ? 'request' : 'meeting'}`
      : op === 'reschedule'
        ? `${issuer} · move the ${investor || 'investor'} meeting`
        : op === 'update'
          ? `${issuer} × ${investor || 'investor'} · ${e.attendees || '?'} attendees now`
          : op === 'confirm'
            ? `${issuer} confirmed the ${investor || 'investor'} meeting`
            : e.category === 'New Meeting Request'
              ? check?.issuerAsked
                ? `${issuer} asked to meet ${investor || 'an investor'}`
                : `${investor || 'An investor'} asked to meet ${issuer}`
              : ['add', 'remove', 'replace'].includes(op)
                ? `${issuer} sent availability`
                : blockedWindows.length
                  ? `${issuer} said some times don’t work`
                  : email.subject;

  const blockers: string[] = [];
  if (escalation) blockers.push('Escalations are acknowledged and assigned, not approved.');
  if (check?.stale) blockers.push('The meeting changed since this email — refresh first.');
  if (!e.conferenceId) blockers.push('Pick the event.');
  if (!e.issuerId) blockers.push('Pick the issuer.');
  if (needsMeeting && !cancelRequest && !meetingId) blockers.push('Pick the meeting this is about.');
  if ((needsRequest || cancelRequest) && !requestId) blockers.push('Pick the request.');
  if (e.category === 'New Meeting Request' && newWindows.length !== 1) blockers.push('Needs exactly one requested time.');
  if (op === 'reschedule' && !newWindows.length) blockers.push('Needs the new time.');
  if (['add', 'remove', 'replace'].includes(op) && !newWindows.length && !blockedWindows.length)
    blockers.push('No exact times — ask the sender or add them.');
  if (op === 'reschedule' && check?.hard.length) blockers.push('The new time clashes (see above).');
  if (op === 'reschedule' && softOutside && !extend) blockers.push('Outside the issuer’s availability.');
  if (op === 'reschedule' && !(consent.issuer && consent.investor)) blockers.push('Record that both sides agreed.');
  if (e.conditional && !conditionMet) blockers.push('Confirm the condition holds.');
  if (dupes.length && !extraMeeting) blockers.push('Confirm this is an additional meeting.');
  if (issues.length && note.trim().length < 10) blockers.push('Note how you resolved the open questions.');
  if (check?.hold && holdOverride.trim().length < 5) blockers.push('Give a reason to override the hold.');
  if (check?.protected && ['cancel', 'reschedule'].includes(op) && protectedOverride.trim().length < 5)
    blockers.push('Give a reason to move a protected meeting.');
  if (dirty) blockers.push('Save your edits first.');
  const canApprove = !blockers.length;

  async function decide(decision: 'approve' | 'reject' | 'edit' | 'acknowledge' | 'refresh' | 'handled' | 'quarantine') {
    const autoNote =
      meeting && needsMeeting
        ? `Verified affected meeting: ${n.investor(meeting.investorId)} · ${fmt(meeting.start, zone)}`
        : req && (needsRequest || cancelRequest)
          ? `Verified request: ${n.investor(req.investorId)} · ${fmt(req.start, zone)}`
          : '';
    const parts = [
      note.trim(),
      hasSelectUncertainty ? autoNote : '',
      e.conditional && conditionMet ? `Condition confirmed: ${e.condition}` : '',
      unverified && trustReason.trim() ? `Sender trusted because: ${trustReason.trim()}` : '',
    ];
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
        consent: decision === 'approve' && (needsMeeting || needsRequest || cancelRequest),
        requestId: requestId || undefined,
        meetingId: (!cancelRequest && meetingId) || undefined,
        senderOverride: decision === 'approve' && unverified && trustReason.trim().length >= 10,
        duplicateConfirmed: extraMeeting,
        assignTo: decision === 'acknowledge' ? owner : undefined,
        conditionMet,
        consentParties: [consent.issuer && 'issuer', consent.investor && 'investor'].filter(Boolean),
        extendAvailability: extend,
        holdOverride: holdOverride || undefined,
        protectedOverride: protectedOverride || undefined,
      },
      decision === 'approve'
        ? 'Approved. Schedule updated.'
        : decision === 'reject'
          ? 'Rejected. Nothing changed on the schedule.'
          : decision === 'acknowledge'
            ? `Acknowledged. ${n.user(owner)} owns the follow-up.`
            : decision === 'refresh'
              ? 'Re-checked against the current meeting.'
              : decision === 'handled'
                ? 'Marked as handled manually.'
                : decision === 'quarantine'
                  ? 'Reported as phishing. Nothing from this email was applied.'
                  : 'Edits saved',
    );
    setBusy(false);
    if (ok && !['edit', 'refresh'].includes(decision)) onDone();
  }

  const offered = (w: Extraction['windows'][number]) =>
    `${op === 'remove' ? 'Removes ' : op === 'reschedule' ? 'Moves to ' : op === 'replace' ? 'Only ' : e.category === 'New Meeting Request' ? (e.flexible ? 'Any time ' : 'Requested ') : 'Adds '}${windowLabel(w, zone)}`;

  return (
    <section className="decision-card" aria-label="Decision">
      <span className="dc-meta">
        {escalation ? <span className="dc-urgent">Urgent</span> : null}
        {e.fromEscalation && <span className="mini-flag red">From an escalation</span>}
        {e.conditional && <span className="mini-flag amber">Conditional</span>}{' '}
        {e.summary || headline}
      </span>
      <h2>{headline}</h2>

      {check?.hold && !done && (
        <div className="hold-banner" role="alert">
          <strong>All changes for {issuer} are on hold</strong>
          <span>{check.hold}</span>
          <input className="dc-input" placeholder="Override reason (required to change anything for this issuer)" value={holdOverride} onChange={(ev) => setHoldOverride(ev.target.value)} />
        </div>
      )}
      {(otherAsks.length > 0 || newer.length > 0) && !done && (
        <div className="related" role="note">
          {newer.map((x) => (
            <button key={x.id} className="related-item newer" onClick={() => onOpenEmail?.(x.id)}>
              <strong>Newer reply from {x.originalSenderName || x.sender}</strong> · {fmt(x.receivedAt, zone, 'EEE h:mm a')}:{' '}
              {x.proposals.map((p) => p.summary).join(' · ') || x.subject}
            </button>
          ))}
          {otherAsks.map(({ email: x, p }) => (
            <button key={p.id} className="related-item" onClick={() => onOpenEmail?.(x.id)}>
              <strong>Also open about this meeting:</strong> {p.summary} · from {x.originalSenderName || x.sender}
            </button>
          ))}
        </div>
      )}
      {check?.stale && !done && (
        <div className="dc-issue hard">
          <AlertTriangle size={15} />
          <div>
            <strong>The meeting changed after this email arrived</strong>
            <p>{check.stale}. Check the email still applies.</p>
            <div className="dc-actions">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => decide('refresh')}>
                Re-check against the current meeting
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => decide('handled')}>
                Mark handled manually
              </Button>
            </div>
          </div>
        </div>
      )}

      {done && (
        <div className="dc-waiting">
          <p>
            {proposal.status === 'Acknowledged'
              ? `Acknowledged. ${n.user(action?.assignedTo || null)} owns the follow-up${action?.status === 'Resolved' ? ' (resolved).' : '.'}`
              : `Already handled: ${proposal.status.toLowerCase()}${proposal.reviewNote ? ` — ${proposal.reviewNote.split('\n')[0]}` : ''}.`}
          </p>
          {proposal.status === 'Acknowledged' && action && action.status !== 'Resolved' && (
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
          <p>Waiting on a reply from the sender. Nothing changes on the schedule until you approve.</p>
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
            {needsMeeting && !cancelRequest ? (
              meeting ? (
                <>
                  <s>{fmt(meeting.start, zone, 'EEE, MMM d · h:mm a')}</s>
                  <span>
                    {n.issuer(meeting.issuerId)} × {n.investor(meeting.investorId)} · {meeting.location || 'Location TBC'}
                    {op === 'update' ? ` · ${meeting.expectedAttendees} attendees` : ''}
                  </span>
                </>
              ) : (
                <span>Pick the meeting below</span>
              )
            ) : needsRequest || cancelRequest ? (
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
                <strong>{cancelRequest ? 'Request withdrawn' : 'Meeting cancelled'}</strong>
                <span>The slot opens up again</span>
              </>
            ) : op === 'update' ? (
              <>
                <strong>{e.attendees} attendees</strong>
                <span>Room re-checked for the new headcount</span>
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
                {e.flexible
                  ? `${e.durationMinutes || 30} min, placed in the first open slot`
                  : e.durationMinutes
                    ? `${e.durationMinutes} min`
                    : `${Math.round((+new Date(newWindows[0].end) - +new Date(newWindows[0].start)) / 60000)} min${newWindows[0].source === 'email' && !/\d\s*[-–]\s*\d/.test(newWindows[0].evidence) ? ' (default slot)' : ''}`}
                {e.attendees ? ` · ${e.attendees} attendees` : ''} · requested by {asker}
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

      {!escalation && !done && check && (check.hard.length > 0 || check.soft.length > 0) && (
        <div className={`dc-issue ${check.hard.length ? 'hard' : ''}`}>
          <AlertTriangle size={15} />
          <div>
            <strong>{check.hard.length ? 'This time does not work' : 'Check before approving'}</strong>
            {[...check.hard, ...check.soft].map((x) => (
              <p key={x}>{x}</p>
            ))}
            {softOutside && op === 'reschedule' && check.issuerAsked && (
              <label className="check">
                <input type="checkbox" checked={extend} onChange={(ev) => setExtend(ev.target.checked)} />
                <span>Extend {issuer} availability to cover this (they asked)</span>
              </label>
            )}
            {softOutside && op === 'reschedule' && !check.issuerAsked && (
              <p className="muted-line">Ask {issuer} to confirm the time, or add it to their availability first.</p>
            )}
          </div>
        </div>
      )}
      {!escalation && !done && check && !check.hard.length && !check.soft.length && op === 'reschedule' && newWindows.length > 0 && (
        <p className="dc-why ok">The new time is free for both sides and inside {issuer}’s availability.</p>
      )}

      {e.vague.length > 0 && !escalation && (
        <div className="dc-note">
          <span className="dc-label">Times without an exact window (not applied)</span>
          {e.vague.map((v, i) => (
            <span key={i}>“{v}”</span>
          ))}
        </div>
      )}

      {(needsMeeting && !cancelRequest) && !escalation && (
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
          {check?.protected && ['cancel', 'reschedule'].includes(op) && (
            <div className="hold-banner">
              <strong>Protected meeting</strong>
              <span>{check.protected}</span>
              <input className="dc-input" placeholder="Reason to move or cancel it anyway" value={protectedOverride} onChange={(ev) => setProtectedOverride(ev.target.value)} />
            </div>
          )}
        </div>
      )}
      {(needsRequest || cancelRequest) && !escalation && (
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

      {e.conditional && !done && (
        <div className="dc-issue">
          <AlertTriangle size={15} />
          <div>
            <strong>Conditional ask</strong>
            <p>“{e.condition}”</p>
            <label className="check">
              <input type="checkbox" checked={conditionMet} onChange={(ev) => setConditionMet(ev.target.checked)} />
              <span>I confirmed the condition holds</span>
            </label>
          </div>
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
              <span>This is an additional meeting, not a duplicate</span>
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
          <input className="dc-input" aria-label="Note for the owner" placeholder="Optional note for the owner (internal)" value={note} onChange={(ev) => setNote(ev.target.value)} />
          <div className="dc-actions">
            <Button disabled={busy || !owner} onClick={() => decide('acknowledge')}>
              <Check size={14} /> Acknowledge &amp; assign
            </Button>
            <Button variant="outline" disabled={busy} onClick={onReply}>
              <Mail size={14} /> Reply to {asker}
            </Button>
          </div>
          {e.issuerId && (
            <div className="hold-set">
              {issuerRow?.holdChanges ? (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => run('issuerHold', { issuerId: e.issuerId, hold: false }, `Hold released for ${issuer}.`)}>
                  Release the hold on {issuer}
                </Button>
              ) : (
                <>
                  <input className="dc-input" placeholder={`Why hold all ${issuer} changes? (e.g. CFO asked for a call first)`} value={holdReason} onChange={(ev) => setHoldReason(ev.target.value)} />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || holdReason.trim().length < 3}
                    onClick={() => run('issuerHold', { issuerId: e.issuerId, hold: true, reason: holdReason }, `All ${issuer} changes are on hold.`)}
                  >
                    Hold all changes for {issuer}
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {!done && !escalation && suspicious && !confirming && (
        <div className="dc-actions">
          <Button className="danger" disabled={busy} onClick={() => decide('quarantine')}>
            Report phishing / quarantine
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => decide('reject')}>
            Reject
          </Button>
          {unverified ? null : (
            <button className="text-button" disabled={!canApprove} onClick={() => setConfirming(true)}>
              Approve anyway…
            </button>
          )}
          {unverified && canApprove && (
            <button className="text-button" onClick={() => setConfirming(true)}>
              Approve with a reason…
            </button>
          )}
        </div>
      )}

      {!done && !escalation && (!suspicious || confirming) &&
        (confirming ? (
          <ConfirmStrip
            text={
              suspicious
                ? 'This email looks suspicious. Approve only if you confirmed it with the registered contact.'
                : needsMeeting || needsRequest
                  ? `I checked this with ${issuer}${op === 'reschedule' ? ` and ${investor}` : ''} and they approved the change.`
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
            {op === 'reschedule' && (
              <div className="consent-row">
                <span>Agreed by</span>
                <label className="check">
                  <input type="checkbox" checked={consent.issuer} onChange={(ev) => setConsent({ ...consent, issuer: ev.target.checked })} />
                  <span>{issuer}{check?.issuerAsked ? ' (asked for it)' : ''}</span>
                </label>
                <label className="check">
                  <input type="checkbox" checked={consent.investor} onChange={(ev) => setConsent({ ...consent, investor: ev.target.checked })} />
                  <span>{investor || 'the investor'}{check?.investorAsked ? ' (asked for it)' : ''}</span>
                </label>
              </div>
            )}
            <div className="dc-actions">
              <Button disabled={busy || !canApprove} onClick={() => setConfirming(true)}>
                <Check size={14} /> Approve
              </Button>
              <Button variant="outline" disabled={busy} onClick={onReply}>
                <Mail size={14} /> Reply to {asker}
              </Button>
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
