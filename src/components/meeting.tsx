'use client';
import { Select, TimeSelect } from './ui/select-menu';
import { canOperate, isDesk } from '@/lib/roles';
import { useEffect, useMemo, useState } from 'react';
import { eachDayOfInterval, format, parseISO } from 'date-fns';
import { AlertTriangle, CalendarX2, Download, Pencil } from 'lucide-react';
import type { AppState } from '@/lib/types';
import { Button } from './ui/button';
import { Sheet } from './ui/sheet';
import { Badge, Field, fmt, names, Run } from './shared';
import { HistoryTimeline } from './history';

type Meeting = AppState['meetings'][number];
type Check = { hard: string[]; soft: string[] };

/** Meeting details with manual Edit (move, room, bankers, attendees) and Cancel, both audited. */
export function MeetingDrawer({
  meeting,
  data,
  run,
  close,
  onOpenEmail,
}: {
  meeting: Meeting;
  data: AppState;
  run: Run;
  close: () => void;
  onOpenEmail?: (id: string) => void;
}) {
  const n = names(data);
  const c = data.conferences.find((x) => x.id === meeting.conferenceId)!;
  const [mode, setMode] = useState<'view' | 'edit' | 'cancel'>('view');
  const [reason, setReason] = useState('');
  const [holdOverride, setHoldOverride] = useState('');
  const [protectReason, setProtectReason] = useState('');
  const [confirmHandled, setConfirmHandled] = useState<string | null>(null);
  const [protectOverride, setProtectOverride] = useState('');
  const [busy, setBusy] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const issuer = data.issuers.find((i) => i.id === meeting.issuerId) as
    | (AppState['issuers'][number] & { holdChanges?: boolean; holdReason?: string })
    | undefined;
  // Open email asks about this meeting: after a manual change they can be closed as handled.
  const openAsks = data.emails.flatMap((x) =>
    x.proposals
      .filter((p) => ['Pending', 'Clarification requested'].includes(p.status))
      .filter((p) => {
        const e = p.extraction as unknown as { meetingId?: string; issuerId?: string; investorId?: string; operation?: string };
        return (
          e?.meetingId === meeting.id ||
          (e?.issuerId === meeting.issuerId &&
            e?.investorId === meeting.investorId &&
            ['cancel', 'reschedule', 'update', 'confirm'].includes(e?.operation || ''))
        );
      })
      .map((p) => ({ p, email: x })),
  );
  const banker = canOperate(data.user);
  const coverage = data.coverageAssignments.filter((a) => a.meetingId === meeting.id);
  const room = data.cubeAssignments.find((a) => a.meetingId === meeting.id);
  const cube = data.meetingCubes.find((x) => x.id === room?.cubeId);
  const bankers = coverage.length
    ? [...coverage]
        .sort((a, b) => Number(b.coverageRole === 'Primary') - Number(a.coverageRole === 'Primary'))
        .map((a) => `${n.user(a.bankerId)} (${a.coverageRole})`)
    : meeting.bankerIds.map(n.user);
  return (
    <Sheet
      open
      onOpenChange={(v) => !v && close()}
      title={`${n.issuer(meeting.issuerId)} × ${n.investor(meeting.investorId)}`}
      description={`${c.name} · times in ${c.timezone.replace('_', ' ')}`}
    >
      {mode === 'view' && (
        <section className="decision-card">
          {issuer?.holdChanges && (
            <div className="hold-banner">
              <strong>All changes for {issuer.name} are on hold</strong>
              <span>{issuer.holdReason}</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Badge>{meeting.status}</Badge>
            {meeting.protected && <Badge tone="red">Protected</Badge>}
            {coverage.some((a) => a.assignmentStatus === 'Needs Review') && (
              <Badge tone="amber">Resources need review</Badge>
            )}
          </div>
          {meeting.protected && (
            <div className="protect-banner">
              <strong>Do not move: {meeting.protectedReason || 'protected'}</strong>
              <span>
                Set by {n.user(meeting.protectedBy || '')} · moving or cancelling needs an override reason.
              </span>
              {banker && (
                <button className="text-button" onClick={() => run('meetingProtect', { id: meeting.id, protected: false }, 'Protection removed.')}>
                  Remove protection
                </button>
              )}
            </div>
          )}
          {banker && !meeting.protected && +new Date(meeting.end) > +new Date(data.now) && (
            <details className="protect-toggle">
              <summary>Protect this meeting (do not move)</summary>
              <div className="dc-actions">
                <input placeholder="Why, e.g. BlackRock asked us not to move it again" value={protectReason} onChange={(e) => setProtectReason(e.target.value)} />
                <Button size="sm" variant="outline" disabled={protectReason.trim().length < 3} onClick={() => run('meetingProtect', { id: meeting.id, protected: true, reason: protectReason }, 'Meeting protected.')}>
                  Protect
                </Button>
              </div>
            </details>
          )}
          {+new Date(meeting.end) <= +new Date(data.now) && <p className="dc-why">This meeting already took place.</p>}
          <h2>
            {fmt(meeting.start, c.timezone, 'EEEE, MMM d · h:mm a')} –{' '}
            {fmt(meeting.end, c.timezone, 'h:mm a')}
          </h2>
          <dl className="meeting-facts">
            <dt>Room / location</dt>
            <dd>
              {[
                cube?.name,
                meeting.location && !meeting.location.startsWith(cube?.name || '\u0000')
                  ? meeting.location
                  : '',
              ]
                .filter(Boolean)
                .join(' · ') || 'To be confirmed'}
            </dd>
            <dt>Bankers</dt>
            <dd>{bankers.join(', ') || 'Unassigned'}</dd>
            <dt>Attendees</dt>
            <dd>
              {meeting.expectedAttendees} expected
              {cube ? ` · ${cube.name} seats ${cube.capacity}` : ''}
            </dd>
            <dt>Recipients</dt>
            <dd>{meeting.approvedRecipients.join(', ') || 'Not sent yet'}</dd>
          </dl>
          {banker && meeting.status === 'Confirmed' && (
            <div className="dc-actions">
              <Button onClick={() => setMode('edit')}>
                <Pencil size={14} /> Edit meeting
              </Button>
              <Button variant="outline" onClick={() => setMode('cancel')}>
                <CalendarX2 size={14} /> Cancel meeting
              </Button>
              <Button variant="ghost" asChild>
                <a
                  href={`/api/export?conferenceId=${meeting.conferenceId}&scope=meeting&id=${meeting.id}&format=ics`}
                >
                  <Download size={14} /> Calendar file
                </a>
              </Button>
            </div>
          )}
          {meeting.changedAt && (
            <p className="muted-line">
              Last changed {fmt(meeting.changedAt, c.timezone, 'MMM d, h:mm a')} by {n.user(meeting.changedBy)}:{' '}
              {meeting.changeSummary}
            </p>
          )}
          {openAsks.length > 0 && (
            <div className="related">
              <span className="dc-label">Open email asks about this meeting</span>
              {openAsks.map(({ p, email }) => (
                <div key={p.id} className="related-item static">
                  <span>
                    <strong>{p.summary}</strong> · from {email.originalSenderName || email.sender}
                  </span>
                  {banker && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        confirmHandled !== p.id
                          ? setConfirmHandled(p.id)
                          : run(
                          'review',
                          {
                            id: p.id,
                            decision: 'handled',
                            meetingId: meeting.id,
                            note: meeting.changeSummary
                              ? `Meeting changed manually: ${meeting.changeSummary}`
                              : 'Handled in the meeting editor',
                          },
                          'Marked as handled manually. Reopen it from the queue (Status → Resolved) if needed.',
                        )
                      }
                    >
                      {confirmHandled === p.id ? 'Confirm: handled manually' : 'Mark handled manually'}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
          <details className="meeting-history" open={false}>
            <summary className="dc-label">History</summary>
            <HistoryTimeline meetingId={meeting.id} timezone={c.timezone} onOpenEmail={onOpenEmail} />
          </details>
        </section>
      )}
      {mode === 'edit' && (
        <MeetingForm
          data={data}
          run={run}
          meeting={meeting}
          conferenceId={meeting.conferenceId}
          onCancel={() => setMode('view')}
          onSaved={() => setMode('view')}
          onReload={() => setFormKey((k) => k + 1)}
          key={formKey}
        />
      )}
      {mode === 'cancel' && (
        <section className="decision-card">
          <h2>Cancel this meeting?</h2>
          <p className="dc-text">
            The slot opens up again and pending confirmation drafts are withdrawn. The cancellation
            is recorded with your reason.
          </p>
          <Field label="Reason (required)">
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Investor called — PM flying home early"
            />
          </Field>
          {issuer?.holdChanges && (
            <Field label={`Hold override for ${issuer.name} (required)`}>
              <input value={holdOverride} onChange={(e) => setHoldOverride(e.target.value)} />
            </Field>
          )}
          {meeting.protected && (
            <>
              <p className="danger-note">Protected: {meeting.protectedReason}. Cancelling it goes against what the investor asked.</p>
              <Field label="Override reason (required)">
                <input value={protectOverride} onChange={(e) => setProtectOverride(e.target.value)} placeholder="e.g. Investor called and agreed" />
              </Field>
            </>
          )}
          <div className="dc-actions">
            <Button
              disabled={
                busy || reason.trim().length < 3 || (Boolean(issuer?.holdChanges) && holdOverride.trim().length < 5) || (meeting.protected && protectOverride.trim().length < 5)
              }
              onClick={async () => {
                setBusy(true);
                const ok = await run(
                  'meetingCancel',
                  { id: meeting.id, reason, version: meeting.version, holdOverride: holdOverride || undefined, protectedOverride: protectOverride || undefined },
                  'Meeting cancelled and recorded.',
                );
                setBusy(false);
                if (ok) setMode('view');
              }}
            >
              Cancel meeting
            </Button>
            <Button variant="ghost" onClick={() => setMode('view')}>
              Back
            </Button>
          </div>
        </section>
      )}
    </Sheet>
  );
}

/** Create or edit a meeting; conflicts are checked live against availability, meetings, bankers and rooms. */
export function MeetingForm({
  data,
  run,
  meeting,
  conferenceId,
  onCancel,
  onSaved,
  onReload,
}: {
  data: AppState;
  run: Run;
  meeting?: Meeting;
  conferenceId: string;
  onCancel: () => void;
  onSaved: () => void;
  onReload?: () => void;
}) {
  const [baseVersion] = useState(meeting?.version ?? 0);
  const [holdOverride, setHoldOverride] = useState('');
  const c = data.conferences.find((x) => x.id === conferenceId)!;
  const zone = c.timezone;
  const days = eachDayOfInterval({ start: parseISO(c.startDate), end: parseISO(c.endDate) }).map(
    (d) => format(d, 'yyyy-MM-dd'),
  );
  const coverage = meeting
    ? data.coverageAssignments.filter((a) => a.meetingId === meeting.id)
    : [];
  const currentBankers = coverage.length
    ? [...coverage]
        .sort((a, b) => Number(b.coverageRole === 'Primary') - Number(a.coverageRole === 'Primary'))
        .map((a) => a.bankerId)
    : meeting?.bankerIds || [];
  const [issuerId, setIssuerId] = useState(meeting?.issuerId || '');
  const [investorId, setInvestorId] = useState(meeting?.investorId || '');
  // A new meeting defaults to the next half hour still to come.
  const nextSlot = new Date(Math.ceil(+new Date(data.now) / 1800000) * 1800000);
  const defaultDay = days.find((d) => d >= fmt(nextSlot.toISOString(), zone, 'yyyy-MM-dd')) || days[0];
  const defaultTime = defaultDay === fmt(nextSlot.toISOString(), zone, 'yyyy-MM-dd') && fmt(nextSlot.toISOString(), zone, 'HH:mm') > '09:00' ? fmt(nextSlot.toISOString(), zone, 'HH:mm') : '09:00';
  const [date, setDate] = useState(meeting ? fmt(meeting.start, zone, 'yyyy-MM-dd') : defaultDay);
  const [time, setTime] = useState(meeting ? fmt(meeting.start, zone, 'HH:mm') : defaultTime);
  const [duration, setDuration] = useState(
    meeting ? Math.round((+new Date(meeting.end) - +new Date(meeting.start)) / 60000) : 30,
  );
  const [cubeId, setCubeId] = useState(
    data.cubeAssignments.find((a) => a.meetingId === meeting?.id)?.cubeId || '',
  );
  const [location, setLocation] = useState(meeting?.location || '');
  const [bankerIds, setBankerIds] = useState<string[]>(currentBankers);
  const [attendees, setAttendees] = useState(meeting?.expectedAttendees || 4);
  const [reason, setReason] = useState('');
  const [override, setOverride] = useState(false);
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);
  const cubes = data.meetingCubes.filter((x) => x.conferenceId === conferenceId);
  const bankers = data.users.filter((u) => u.role === 'BANKER');
  const payload = useMemo(
    () => ({
      date,
      time,
      duration,
      location,
      cubeId: cubeId || null,
      bankerIds,
      attendees,
    }),
    [date, time, duration, location, cubeId, bankerIds, attendees],
  );
  // Live conflict check (debounced) so the banker sees problems before saving.
  useEffect(() => {
    if (!issuerId || !investorId || !/^\d{2}:\d{2}$/.test(time)) return;
    const t = setTimeout(async () => {
      try {
        const r = await fetch('/api/commands', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'meetingCheck',
            data: { ...payload, id: meeting?.id, conferenceId, issuerId, investorId },
          }),
        });
        const out = await r.json();
        if (r.ok) setCheck(out.result);
      } catch {
        /* the save itself re-checks */
      }
    }, 300);
    return () => clearTimeout(t);
  }, [payload, issuerId, investorId, conferenceId, meeting?.id, time]);
  const reasonOk = meeting
    ? reason.trim().length >= 3
    : !check?.soft.length || reason.trim().length >= 3;
  const issuerRow = data.issuers.find((i) => i.id === (meeting?.issuerId || issuerId)) as
    | (AppState['issuers'][number] & { holdChanges?: boolean; holdReason?: string })
    | undefined;
  const changedMeanwhile = Boolean(meeting && meeting.version !== baseVersion);
  const movesProtected = Boolean(
    meeting?.protected && (date !== fmt(meeting.start, zone, 'yyyy-MM-dd') || time !== fmt(meeting.start, zone, 'HH:mm')),
  );
  const blocked =
    Boolean(check?.hard.length) ||
    ((Boolean(check?.soft.length) || movesProtected) && !override) ||
    !reasonOk ||
    !issuerId ||
    !investorId ||
    changedMeanwhile ||
    (Boolean(issuerRow?.holdChanges) && holdOverride.trim().length < 5);
  async function save() {
    setBusy(true);
    const ok = meeting
      ? await run(
          'meetingUpdate',
          { ...payload, id: meeting.id, reason, override, version: baseVersion, holdOverride: holdOverride || undefined },
          'Meeting updated. Change recorded with your reason.',
        )
      : await run(
          'meetingCreate',
          { ...payload, conferenceId, issuerId, investorId, reason, override },
          'Meeting created and added to the schedule.',
        );
    setBusy(false);
    if (ok) onSaved();
  }
  return (
    <section className="decision-card meeting-form">
      <h2>{meeting ? 'Edit meeting' : 'New meeting'}</h2>
      {changedMeanwhile && meeting && (
        <div className="dc-issue hard">
          <AlertTriangle size={15} />
          <div>
            <strong>
              Changed by {data.users.find((u) => u.id === meeting.changedBy)?.name || 'someone else'} while you were editing
            </strong>
            <p>{meeting.changeSummary}. Load the latest values and reapply your change.</p>
            <Button size="sm" variant="outline" onClick={onReload}>
              Load latest values
            </Button>
          </div>
        </div>
      )}
      {issuerRow?.holdChanges && (
        <div className="hold-banner">
          <strong>All changes for {issuerRow.name} are on hold</strong>
          <span>{issuerRow.holdReason}</span>
          <input
            className="dc-input"
            placeholder="Override reason (required)"
            value={holdOverride}
            onChange={(e) => setHoldOverride(e.target.value)}
          />
        </div>
      )}
      {meeting?.protected && (
        <p className="dc-why">
          Protected: {meeting.protectedReason}. Moving it needs “Schedule anyway” and a reason.
        </p>
      )}
      {!meeting && (
        <div className="two-cols">
          <Field label="Issuer">
            <Select value={issuerId} onChange={(e) => setIssuerId(e.target.value)}>
              <option value="">— Pick —</option>
              {[...data.issuers]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Investor">
            <Select value={investorId} onChange={(e) => setInvestorId(e.target.value)}>
              <option value="">— Pick —</option>
              {[...data.investors]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
      )}
      <div className="three-cols">
        <Field label="Day">
          <Select value={date} onChange={(e) => setDate(e.target.value)}>
            {days.map((d) => (
              <option key={d} value={d}>
                {format(parseISO(d), 'EEE, MMM d')}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Start" hint={zone.replace('_', ' ')}>
          <TimeSelect step={5} value={time} onChange={setTime} ariaLabel="Start" />
        </Field>
        <Field label="Length">
          <Select value={duration} onChange={(e) => setDuration(+e.target.value)}>
            {[15, 30, 45, 60, 90, 120].map((d) => (
              <option key={d} value={d}>
                {d} min
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="two-cols">
        <Field label="Meeting room">
          <Select value={cubeId} onChange={(e) => setCubeId(e.target.value)}>
            <option value="">No cube</option>
            {cubes.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} · seats {x.capacity}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Attendees">
          <input
            type="number"
            min={1}
            max={500}
            value={attendees}
            onChange={(e) => setAttendees(Math.max(1, Math.round(+e.target.value || 1)))}
          />
        </Field>
      </div>
      <Field
        label="Location note"
        hint="Optional — e.g. a private room or dial-in. Defaults to the cube's building and floor."
      >
        <input
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="e.g. Ocean Tower · 201"
        />
      </Field>
      <Field label="Bankers" hint="First one is the primary.">
        <div className="banker-picks">
          {bankers.map((b) => {
            const on = bankerIds.includes(b.id);
            return (
              <button
                key={b.id}
                type="button"
                className={`chip ${on ? 'active' : ''}`}
                onClick={() =>
                  setBankerIds(on ? bankerIds.filter((x) => x !== b.id) : [...bankerIds, b.id])
                }
              >
                {on && bankerIds[0] === b.id ? '★ ' : ''}
                {b.name}
              </button>
            );
          })}
        </div>
      </Field>
      {check && (check.hard.length > 0 || check.soft.length > 0 || movesProtected) ? (
        <div className={`dc-issue ${check.hard.length ? 'hard' : ''}`}>
          <AlertTriangle size={15} />
          <div>
            <strong>{check.hard.length ? 'This time does not work' : 'Check before saving'}</strong>
            {[...check.hard, ...check.soft, ...(movesProtected ? [`Protected meeting: ${meeting?.protectedReason}`] : [])].map((x) => (
              <p key={x}>{x}</p>
            ))}
            {!check.hard.length && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={override}
                  onChange={(e) => setOverride(e.target.checked)}
                />
                <span>Schedule anyway (the reason below is recorded)</span>
              </label>
            )}
          </div>
        </div>
      ) : check ? (
        <p className="dc-why ok">
          No conflicts with availability, other meetings, bankers or rooms.
        </p>
      ) : null}
      <Field
        label={
          meeting
            ? 'Reason for the change (required)'
            : 'Reason / source (optional unless overriding)'
        }
      >
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Ford IR asked by phone, 10:40 AM"
        />
      </Field>
      <div className="dc-actions">
        <Button disabled={busy || blocked} onClick={save}>
          {meeting ? 'Save changes' : 'Create meeting'}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Back
        </Button>
      </div>
    </section>
  );
}
