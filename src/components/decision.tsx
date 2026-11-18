'use client';
import { useEffect, useRef, useState } from 'react';
import type { AppState, EmailItem, RequestItem } from '@/lib/types';
import type { Extraction } from '@/lib/extraction-schema';
import { duplicatesFor, findCandidates, isOpenMeeting, isOpenRequest, windowLabel } from '@/lib/review-rules';
import { ExtractionForm } from './extraction-form';
import { AlertTriangle, ArrowRight, Check, ChevronDown, Mail, Users } from 'lucide-react';
import { CordaMark } from './ui/corda-mark';
import { DraftPreview } from './draft-preview';
import { canOperate } from '@/lib/roles';
import { SelectMenu } from './ui/select-menu';
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
  availability?: { mode: 'narrow' | 'extend'; days: { day: string; before: string[]; after: string[]; outside: string[] }[] } | null;
  timeNote?: string | null;
};
const MEETING_OPS = ['cancel', 'reschedule', 'update'];

export type Outcome = { kind: string; meetingId?: string | null; text: string };
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
  onDone: (outcome?: Outcome | null) => void;
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
  const outcomeRef = useRef<Outcome | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
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
  const [pickOpen, setPickOpen] = useState(false);
  const [check, setCheck] = useState<Check | null>(null);
  const action = data.actions.find((a) => a.proposalId === proposal.id);
  // One coordinator runs the inbox: whoever acknowledges an escalation owns it.
  const owner = data.user.id;
  const [showRelated, setShowRelated] = useState(false);
  const [holdOpen, setHoldOpen] = useState(false);
  const op = e.operation;
  const unverified = email.senderStatus === 'unverified';
  const suspicious = email.suspicious;
  const escalation = e.category === 'Escalation / complaint';
  const needsMeeting = MEETING_OPS.includes(op);
  const needsRequest = op === 'confirm';
  const meetingPick = findCandidates(e, data.meetings, { zone, trusted: !suspicious, open: isOpenMeeting, n, now: new Date(data.now) });
  const requestPick = findCandidates(e, data.requests, { zone, trusted: !suspicious, open: isOpenRequest, n, noun: 'request', now: new Date(data.now) });
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
  // An email that asks for / accepts a time with a known counterpart answers an open request for
  // the same pair: approving confirms that request at the email's time (no duplicate, no second page).
  const isNew = e.category === 'New Meeting Request';
  const openReq = isNew
    ? data.requests.find(
        (r) =>
          isOpenRequest(r.status) &&
          r.issuerId === e.issuerId &&
          r.investorId === e.investorId &&
          (!e.conferenceId || r.conferenceId === e.conferenceId) &&
          +new Date(r.end) > +new Date(data.now),
      )
    : undefined;
  const [confirmNow, setConfirmNow] = useState(false);
  const dupes = isNew ? duplicatesFor(e, data.meetings, data.requests).filter((d) => d.item.id !== openReq?.id) : [];
  const waiting = proposal.status === 'Clarification requested';
  const waitingSales = proposal.status === 'Waiting on sales';
  /** The salesperson's answer on a reschedule they were asked to check. */
  const salesAnswer = proposal.status === 'Pending' && /^.+ says the new time (?:works|does not work)/.test(proposal.reviewNote || '') ? proposal.reviewNote : null;
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
    (x) =>
      x.threadId === email.threadId &&
      x.id !== email.id &&
      x.status !== 'Quarantined' && // reported phishing never shows as a normal reply
      (x.receivedAt > email.receivedAt || (x.receivedAt === email.receivedAt && x.id > email.id)),
  );
  const softOutside = (check?.soft || []).some((x) => x.startsWith('Outside'));
  // Requester → counterpart, decided from the (original) sender so it never flips while loading.
  const senderDomain = (email.originalSender || email.sender).split('@')[1]?.toLowerCase() || '';
  const issuerContact = (data.issuers.find((i) => i.id === e.issuerId) as { contactEmail?: string } | undefined)?.contactEmail;
  const issuerRequested = Boolean(issuerContact && issuerContact.split('@')[1]?.toLowerCase() === senderDomain) || Boolean(check?.issuerAsked);
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
              ? issuerRequested
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
  if (isNew && openReq && !confirmNow) blockers.push('Tick that the issuer agreed to confirm the open request.');
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
        consent: decision === 'approve' && (needsMeeting || needsRequest || cancelRequest || (isNew && confirmNow)),
        confirmNow: decision === 'approve' && isNew && confirmNow,
        requestId: (isNew ? openReq?.id : requestId) || undefined,
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
        ? (r: unknown) => {
            const o = (r as { outcome?: Outcome } | null)?.outcome;
            outcomeRef.current = o || null;
            return o?.text || 'Approved. Schedule updated.';
          }
        : decision === 'reject'
          ? 'Rejected. Nothing changed on the schedule.'
          : decision === 'acknowledge'
            ? 'Acknowledged.'
            : decision === 'refresh'
              ? 'Re-checked against the current meeting.'
              : decision === 'handled'
                ? 'Marked as handled manually.'
                : decision === 'quarantine'
                  ? 'Reported as phishing. Nothing from this email was applied.'
                  : 'Edits saved',
    );
    setBusy(false);
    if (ok && !['edit', 'refresh'].includes(decision)) onDone(decision === 'approve' ? outcomeRef.current : null);
  }

  // One plain sentence for the change and one line for its time(s): "Move Ford Credit × Wellington",
  // "Dec 8 · 10:00 AM → 11:30 AM". Weekdays are left out; the date says it.
  const D = (iso: string | Date) => fmt(typeof iso === 'string' ? iso : iso.toISOString(), zone, 'MMM d · h:mm a');
  const T = (iso: string | Date) => fmt(typeof iso === 'string' ? iso : iso.toISOString(), zone, 'h:mm a');
  const sameDay = (a: string | Date, b: string | Date) => fmt(String(typeof a === 'string' ? a : a.toISOString()), zone, 'yyyy-MM-dd') === fmt(String(typeof b === 'string' ? b : b.toISOString()), zone, 'yyyy-MM-dd');
  const range = (w: { start: string; end: string }) => `${fmt(w.start, zone, 'MMM d · h:mm')}–${T(w.end)}`;
  const pairName = meeting
    ? `${n.issuer(meeting.issuerId)} × ${n.investor(meeting.investorId)}`
    : req
      ? `${n.issuer(req.issuerId)} × ${n.investor(req.investorId)}`
      : [e.issuerId ? issuer : null, investor || null].filter(Boolean).join(' × ') || 'the meeting';
  const firstNew = newWindows[0];
  const change: { what: string; when: string; sub: string } = (() => {
    if (op === 'reschedule')
      return {
        what: `Move ${pairName}`,
        when: meeting && firstNew ? `${D(meeting.start)} → ${sameDay(meeting.start, firstNew.start) ? T(firstNew.start) : D(firstNew.start)}` : firstNew ? `New time ${D(firstNew.start)}` : 'The email gives no exact new time',
        sub: '',
      };
    if (op === 'cancel') return { what: cancelRequest ? `Withdraw the request ${pairName}` : `Cancel ${pairName}`, when: meeting ? D(meeting.start) : req ? D(req.start) : '', sub: 'The slot opens up again' };
    if (op === 'update') return { what: `Update ${pairName}`, when: meeting ? D(meeting.start) : '', sub: e.attendees ? `${e.attendees} attendees${meeting ? ` (now ${meeting.expectedAttendees})` : ''} · room re-checked` : '' };
    if (op === 'confirm') return { what: `Confirm ${pairName}`, when: req ? D(req.start) : firstNew ? D(firstNew.start) : '', sub: '' };
    if (e.category === 'New Meeting Request')
      return {
        what: `Add ${pairName}`,
        when: firstNew ? (e.flexible ? `Any time ${range(firstNew)}` : D(firstNew.start)) : 'The email gives no exact time',
        sub: [
          firstNew ? `${e.durationMinutes || Math.round((+new Date(firstNew.end) - +new Date(firstNew.start)) / 60000)} min` : '',
          e.attendees ? `${e.attendees} attendees` : '',
          `asked by ${asker}`,
          dupes.length ? `already ${dupes[0].kind === 'meeting' ? 'meets' : 'requested'} ${D(dupes[0].item.start)}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
      };
    if (e.category === 'Issuer Availability Update')
      return {
        what: `${issuer} ${blockedWindows.length && !newWindows.length ? 'is not available' : op === 'remove' ? 'removes times' : op === 'replace' ? 'replaces its availability' : 'is available'}`,
        when: [...newWindows, ...blockedWindows].map(range).join(', ') || 'No exact times',
        sub: current.length ? `Now: ${current.slice(0, 3).map((a) => range({ start: new Date(a.start).toISOString(), end: new Date(a.end).toISOString() })).join(', ')}` : 'No availability on file yet',
      };
    return { what: e.summary || headline, when: firstNew ? D(firstNew.start) : '', sub: '' };
  })();
  const clean = Boolean(check && !check.hard.length && !check.soft.length);
  const roomName = meeting?.location?.split('·')[0].trim();
  const okChips = done
    ? []
    : [
        ...(clean && firstNew && ['reschedule', 'add', 'confirm'].includes(op) ? ['Free for both sides', `Inside ${issuer}’s availability`] : []),
        ...(clean && op === 'reschedule' && roomName ? [`${roomName} stays`] : []),
      ];
  const offered = (w: Extraction['windows'][number]) =>
    `${op === 'remove' ? 'Removes ' : op === 'reschedule' ? 'Moves to ' : op === 'replace' ? 'Only ' : e.category === 'New Meeting Request' ? (e.flexible ? 'Any time ' : 'Requested ') : 'Adds '}${windowLabel(w, zone)}`;

  return (
    <section className="decision-card email-dc" aria-label="Decision">
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
            <button key={x.id} className={`related-item newer ${x.suspicious ? 'danger' : ''}`} onClick={() => onOpenEmail?.(x.id)}>
              <strong>{x.suspicious ? 'Suspicious message (not verified) from ' : 'Newer reply from '}{x.originalSenderName || x.sender}</strong> · {fmt(x.receivedAt, zone, 'EEE h:mm a')}:{' '}
              {x.proposals.map((p) => p.summary).join(' · ') || x.subject}
            </button>
          ))}
          {otherAsks.length > 0 && (
            <button className="related-item more" onClick={() => setShowRelated(!showRelated)} aria-expanded={showRelated}>
              {otherAsks.length} other open {otherAsks.length === 1 ? 'email' : 'emails'} about this meeting
              <ChevronDown size={13} />
            </button>
          )}
          {showRelated &&
            otherAsks.map(({ email: x, p }) => (
              <button key={p.id} className="related-item sub" onClick={() => onOpenEmail?.(x.id)}>
                {p.summary}
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
              ? `Acknowledged${action?.status === 'Resolved' ? ' and resolved' : ''}.`
              : `Already handled: ${proposal.status.toLowerCase()}${proposal.reviewNote?.split('\n').find((l) => l.trim()) ? ` — ${proposal.reviewNote.split('\n').find((l) => l.trim())}` : ''}${proposal.reviewerId ? ` (by ${n.user(proposal.reviewerId)})` : ''}.`}
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
      {waitingSales && (
        <div className="dc-waiting">
          <p>{proposal.reviewNote || 'Waiting on sales.'} Their answer comes back here; then reply to the issuer.</p>
        </div>
      )}
      {salesAnswer && (
        <div className={`dc-sales-answer ${/does not work/.test(salesAnswer) ? 'no' : 'yes'}`}>
          <strong>Sales answered</strong>
          <span>{salesAnswer}</span>
        </div>
      )}

      {escalation ? (
        <div className="dc-escalation">
          <AlertTriangle size={16} />
          <div>
            <strong>Client escalation</strong>
            {[...new Set(e.uncertainties)]
              .filter((u) => !/^client (complaint|escalation)\.?$/i.test(u.trim()))
              .slice(0, 2)
              .map((u, i) => (
                <p key={i}>{u}</p>
              ))}
          </div>
        </div>
      ) : (
        <div className="dc-suggest">
          <div className="dc-suggest-head">
            <CordaMark size={18} /> Suggested
          </div>
          <div className="dc-change">
            <span className="what">{change.what}</span>
            {change.when && <span className="when">{change.when}</span>}
            {change.sub && <span className="sub">{change.sub}</span>}
          </div>
          {okChips.length > 0 && (
            <div className="dc-checks">
              {okChips.map((c) => (
                <span key={c}>
                  <Check size={13} strokeWidth={2.6} /> {c}
                </span>
              ))}
            </div>
          )}
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
      {!escalation && !done && check?.timeNote && <p className="dc-why tz-note">🕑 {check.timeNote}</p>}
      {!escalation && !done && check?.availability && (
        <div className="avail-diff">
          <span className="dc-label">
            {check.availability.mode === 'narrow' ? 'That day becomes exactly these windows' : 'Adds to the current availability'}
          </span>
          {check.availability.days.map((d) => (
            <div key={d.day}>
              <strong>{d.day}</strong>
              <span className="diff-remove">Now: {d.before.join(', ') || 'none'}</span>
              <span className="diff-add">After: {d.after.join(', ')}</span>
              {d.outside.length > 0 && <span className="warn">Booked meetings outside the new windows: {d.outside.join(', ')} (flagged for review)</span>}
            </div>
          ))}
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

      {(needsMeeting && !cancelRequest) && !escalation && (
        <div className="dc-pick-block">
          {meeting && !pickOpen && meetingPick.candidates.length <= 1 ? null : meeting && !pickOpen ? (
            <div className="dc-matched">
              <span className="dc-label">Meeting</span>
              <span title={meetingPick.candidates.find((c) => c.item.id === meetingId)?.reasons.join(' · ')}>
                {n.issuer(meeting.issuerId)} × {n.investor(meeting.investorId)} · {D(meeting.start)}
              </span>
              {!done && meetingPick.candidates.length > 1 && (
                <button className="text-button" onClick={() => setPickOpen(true)}>
                  Change
                </button>
              )}
            </div>
          ) : (
            <label className="dc-pick">
              <span>Meeting</span>
              <SelectMenu
                ariaLabel="Meeting"
                value={meetingId}
                disabled={done}
                placeholder={meetingPick.candidates.length ? 'Choose the meeting' : 'No matching meeting'}
                onChange={(v) => {
                  setMeetingId(v);
                  setPickOpen(false);
                }}
                options={meetingPick.candidates.map((c) => ({
                  value: c.item.id,
                  label: `${n.issuer(c.item.issuerId)} × ${n.investor(c.item.investorId)} · ${D(c.item.start)}`,
                  hint: c.reasons.join(' · '),
                }))}
              />
            </label>
          )}
          {!meeting && <p className="dc-why">{meetingPick.why}</p>}
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
            <SelectMenu
              ariaLabel="Request"
              value={requestId}
              disabled={done}
              placeholder={requestPick.candidates.length ? 'Choose the request' : 'No matching request'}
              onChange={setRequestId}
              options={requestPick.candidates.map((c) => ({ value: c.item.id, label: `${n.investor(c.item.investorId)} · ${D(c.item.start)}` }))}
            />
          </label>
          {!req && <p className="dc-why">{requestPick.why}</p>}
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
        <span className="dc-label">From the email</span>
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

      {!suspicious && (
        <DraftPreview emailId={email.id} version={email.proposals.map((p) => p.status).join(',')} onEdit={onReply} />
      )}

      {!done && escalation && (
        <div className="dc-confirm">
          <input className="dc-input" aria-label="Note" placeholder="Note (optional, internal)" value={note} onChange={(ev) => setNote(ev.target.value)} />
          <div className="dc-actions">
            <Button disabled={busy} onClick={() => decide('acknowledge')}>
              <Check size={14} /> Acknowledge
            </Button>
            <Button variant="outline" disabled={busy} onClick={onReply}>
              <Mail size={14} /> Reply
            </Button>
            {e.issuerId &&
              (issuerRow?.holdChanges ? (
                <button className="text-button" disabled={busy} onClick={() => run('issuerHold', { issuerId: e.issuerId, hold: false }, `Hold released for ${issuer}.`)}>
                  Release hold on {issuer}
                </button>
              ) : (
                <button className="text-button" onClick={() => setHoldOpen(!holdOpen)}>
                  Hold {issuer} changes…
                </button>
              ))}
          </div>
          {e.issuerId && holdOpen && !issuerRow?.holdChanges && (
            <div className="hold-set">
              <input className="dc-input" placeholder="Why? (e.g. CFO asked for a call first)" value={holdReason} onChange={(ev) => setHoldReason(ev.target.value)} />
              <Button
                size="sm"
                variant="outline"
                disabled={busy || holdReason.trim().length < 3}
                onClick={() => run('issuerHold', { issuerId: e.issuerId, hold: true, reason: holdReason }, `All ${issuer} changes are on hold.`)}
              >
                Hold all changes
              </Button>
            </div>
          )}
        </div>
      )}

      {!done && !escalation && suspicious && !confirming && (
        <div className="dc-actions">
          <Button className="danger" disabled={busy} onClick={() => decide('quarantine')}>
            Report phishing / quarantine
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => (rejectOpen ? decide('reject') : setRejectOpen(true))}>
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

      {!done && !waitingSales && !escalation && (!suspicious || confirming) &&
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
            {isNew && newWindows.length === 1 && (
              <div className="consent-row answer-row">
                {openReq && (
                  <p>
                    This email answers the open request <b>{n.investor(openReq.investorId)} × {n.issuer(openReq.issuerId)}</b> ({fmt(openReq.start, zone, 'EEE h:mm a')}). Approving confirms it at{' '}
                    <b>{fmt(newWindows[0].start, zone, 'EEE h:mm a')}</b> and closes the request.
                  </p>
                )}
                <label className="check">
                  <input type="checkbox" checked={confirmNow} onChange={(ev) => setConfirmNow(ev.target.checked)} />
                  <span>{issuer} agreed to this time — confirm the meeting now{openReq ? '' : ' (otherwise a request is created)'}</span>
                </label>
              </div>
            )}
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
                <Check size={14} />{' '}
                {isNew && newWindows.length === 1
                  ? openReq
                    ? `Confirm request at ${fmt(newWindows[0].start, zone, 'EEE h:mm a')}`
                    : confirmNow
                      ? 'Confirm meeting'
                      : 'Create request'
                  : 'Approve'}
              </Button>
              <Button variant="outline" disabled={busy} onClick={onReply}>
                <Mail size={14} /> Reply to {asker}
              </Button>
              {op === 'reschedule' && !salesAnswer && canOperate(data.user) && (
                <Button
                  variant="outline"
                  disabled={busy}
                  title="Before saying yes to the issuer, ask the salesperson to check with the investor"
                  onClick={() => run('askSalesReschedule', { proposalId: proposal.id }, (r) => `Sent to ${(r as { sales?: string })?.sales || 'sales'} to check with the investor.`)}
                >
                  <Users size={14} /> Ask sales first
                </Button>
              )}
              <Button variant="ghost" disabled={busy} onClick={() => (rejectOpen ? decide('reject') : setRejectOpen(true))}>
                Reject
              </Button>
            </div>
            {rejectOpen && (
              <div className="inline-reject">
                <input autoFocus aria-label="Reason for rejecting" placeholder="Reason (shared with the requester), then press Reject again" value={note} onChange={(ev) => setNote(ev.target.value)} />
                <button className="text-button" onClick={() => setRejectOpen(false)}>Cancel</button>
              </div>
            )}
            {!canApprove && <p className="dc-blockers">To approve: {blockers.join(' ')}</p>}
          </>
        ))}

      {!done && (
        <details className="dc-more" open={showEditor} onToggle={(ev) => setShowEditor((ev.target as HTMLDetailsElement).open)}>
          <summary>Edit what Corda read</summary>
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
  // "This time doesn't work": a reason and up to three open times for sales to pick from.
  const suggestions = [...r.alternatives].sort((x, y) => Math.abs(+new Date(x.start) - +new Date(r.start)) - Math.abs(+new Date(y.start) - +new Date(r.start))).slice(0, 5);
  const [noOpen, setNoOpen] = useState(false);
  const [noReason, setNoReason] = useState(conflict ? `${issuer} is not free then` : '');
  const [noPick, setNoPick] = useState<string[]>(() => suggestions.slice(0, 3).map((x) => x.start));
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
    <section className="decision-card email-dc" aria-label="Decision">
      <span className="dc-meta">
        Meeting request · from {n.user(r.salespersonId)} · {c.name}
      </span>
      <h2>
        {investor} wants to meet {issuer}
      </h2>
      <div className="dc-suggest">
        <div className="dc-suggest-head">
          <CordaMark size={18} /> {conflict ? 'That time does not work' : 'Suggested'}
        </div>
        <div className="dc-change">
          <span className="what">
            {conflict ? `${investor} × ${issuer}` : `Confirm ${investor} × ${issuer}`}
          </span>
          <span className="when">{conflict ? <s>{fmt(r.start, c.timezone, 'MMM d · h:mm a')}</s> : fmt(r.start, c.timezone, 'MMM d · h:mm a')}</span>
          <span className="sub">
            {r.duration} min · asked by {n.user(r.salespersonId)}
            {conflict ? ' · pick an open time below, or tell sales it does not work' : ''}
          </span>
        </div>
        {!conflict && (
          <div className="dc-checks">
            <span>
              <Check size={13} strokeWidth={2.6} /> Open on both calendars
            </span>
          </div>
        )}
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
                  {fmt(s.start, c.timezone, 'MMM d · h:mm a')}
                </button>
              ))}
          </div>
        </div>
      )}
      {/Outside .+ availability/.test(r.notes || '') && (
        <div className="dc-issue soft">
          <AlertTriangle size={15} />
          <div>
            <strong>Outside {issuer}’s availability</strong>
            <p>Sales knows and asks whether {issuer} can make an exception. Email the issuer, or tell sales it does not work.</p>
          </div>
        </div>
      )}
      {r.notes && <p className="dc-text">“{r.notes}”</p>}
      {noOpen && (
        <div className="dc-no">
          <strong>Tell {n.user(r.salespersonId)} this time doesn’t work</strong>
          <input aria-label="Why the time does not work" placeholder={`Why, e.g. ${issuer} already has a meeting then`} value={noReason} onChange={(ev) => setNoReason(ev.target.value)} />
          {suggestions.length > 0 && (
            <div className="opts">
              <span>Offer these open times:</span>
              {suggestions.map((sl) => (
                <label key={sl.start} className={noPick.includes(sl.start) ? 'on' : ''}>
                  <input
                    type="checkbox"
                    checked={noPick.includes(sl.start)}
                    onChange={() => setNoPick(noPick.includes(sl.start) ? noPick.filter((x) => x !== sl.start) : [...noPick, sl.start].slice(-3))}
                  />
                  {fmt(sl.start, c.timezone, 'MMM d · h:mm a')}
                </label>
              ))}
            </div>
          )}
          <div className="dc-actions">
            <Button disabled={busy || noReason.trim().length < 3} onClick={() => go('requestTimeNo', { id: r.id, reason: noReason, alternatives: noPick }, `${n.user(r.salespersonId)} was told, with ${noPick.length} open time${noPick.length === 1 ? '' : 's'} to pick from.`)}>
              Send to sales
            </Button>
            <button className="text-button" onClick={() => setNoOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
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
          {!noOpen && (
            <Button variant="outline" disabled={busy} onClick={() => setNoOpen(true)}>
              Time doesn’t work
            </Button>
          )}
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
