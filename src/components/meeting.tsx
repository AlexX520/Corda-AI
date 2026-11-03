'use client';
import { useEffect, useMemo, useState } from 'react';
import { eachDayOfInterval, format, parseISO } from 'date-fns';
import { AlertTriangle, CalendarX2, Download, Pencil } from 'lucide-react';
import type { AppState } from '@/lib/types';
import { Button } from './ui/button';
import { Sheet } from './ui/sheet';
import { Badge, Field, fmt, names, Run } from './shared';

type Meeting = AppState['meetings'][number];
type Check = { hard: string[]; soft: string[] };

/** Meeting details with manual Edit (move, room, bankers, attendees) and Cancel, both audited. */
export function MeetingDrawer({
  meeting,
  data,
  run,
  close,
}: {
  meeting: Meeting;
  data: AppState;
  run: Run;
  close: () => void;
}) {
  const n = names(data);
  const c = data.conferences.find((x) => x.id === meeting.conferenceId)!;
  const [mode, setMode] = useState<'view' | 'edit' | 'cancel'>('view');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const banker = data.user.role === 'BANKER';
  const coverage = data.coverageAssignments.filter((a) => a.meetingId === meeting.id);
  const room = data.cubeAssignments.find((a) => a.meetingId === meeting.id);
  const cube = data.meetingCubes.find((x) => x.id === room?.cubeId);
  const bankers = coverage.length
    ? [...coverage]
        .sort((a, b) => Number(b.coverageRole === 'Primary') - Number(a.coverageRole === 'Primary'))
        .map((a) => `${n.user(a.bankerId)} (${a.coverageRole})`)
    : meeting.bankerIds.map(n.user);
  const history = data.auditLogs.filter(
    (a) => a.entityType === 'Meeting' && a.entityId === meeting.id,
  );
  return (
    <Sheet
      open
      onOpenChange={(v) => !v && close()}
      title={`${n.issuer(meeting.issuerId)} × ${n.investor(meeting.investorId)}`}
      description={`${c.name} · times in ${c.timezone.replace('_', ' ')}`}
    >
      {mode === 'view' && (
        <section className="decision-card">
          <div className="flex items-center gap-2">
            <Badge>{meeting.status}</Badge>
            {coverage.some((a) => a.assignmentStatus === 'Needs Review') && (
              <Badge tone="amber">Resources need review</Badge>
            )}
          </div>
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
          {history.length > 0 && (
            <div className="meeting-history">
              <span className="dc-label">Changes</span>
              {history.slice(0, 6).map((h) => {
                const after = (h.after || {}) as { reason?: string };
                return (
                  <p key={h.id}>
                    <strong>{h.action}</strong> · {n.user(h.actorId)} ·{' '}
                    {fmt(h.createdAt, c.timezone, 'MMM d, h:mm a')}
                    {after.reason ? <em> — “{after.reason}”</em> : null}
                  </p>
                );
              })}
            </div>
          )}
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
          <div className="dc-actions">
            <Button
              disabled={busy || reason.trim().length < 3}
              onClick={async () => {
                setBusy(true);
                const ok = await run(
                  'meetingCancel',
                  { id: meeting.id, reason },
                  'Meeting cancelled and recorded.',
                );
                setBusy(false);
                if (ok) close();
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
}: {
  data: AppState;
  run: Run;
  meeting?: Meeting;
  conferenceId: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
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
  const [date, setDate] = useState(meeting ? fmt(meeting.start, zone, 'yyyy-MM-dd') : days[0]);
  const [time, setTime] = useState(meeting ? fmt(meeting.start, zone, 'HH:mm') : '09:00');
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
  const blocked =
    Boolean(check?.hard.length) ||
    (Boolean(check?.soft.length) && !override) ||
    !reasonOk ||
    !issuerId ||
    !investorId;
  async function save() {
    setBusy(true);
    const ok = meeting
      ? await run(
          'meetingUpdate',
          { ...payload, id: meeting.id, reason, override },
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
      {!meeting && (
        <div className="two-cols">
          <Field label="Issuer">
            <select value={issuerId} onChange={(e) => setIssuerId(e.target.value)}>
              <option value="">— Pick —</option>
              {[...data.issuers]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Investor">
            <select value={investorId} onChange={(e) => setInvestorId(e.target.value)}>
              <option value="">— Pick —</option>
              {[...data.investors]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
            </select>
          </Field>
        </div>
      )}
      <div className="three-cols">
        <Field label="Day">
          <select value={date} onChange={(e) => setDate(e.target.value)}>
            {days.map((d) => (
              <option key={d} value={d}>
                {format(parseISO(d), 'EEE, MMM d')}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Start" hint={zone.replace('_', ' ')}>
          <input type="time" step={300} value={time} onChange={(e) => setTime(e.target.value)} />
        </Field>
        <Field label="Length">
          <select value={duration} onChange={(e) => setDuration(+e.target.value)}>
            {[15, 30, 45, 60, 90, 120].map((d) => (
              <option key={d} value={d}>
                {d} min
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="two-cols">
        <Field label="Meeting room">
          <select value={cubeId} onChange={(e) => setCubeId(e.target.value)}>
            <option value="">No cube</option>
            {cubes.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} · seats {x.capacity}
              </option>
            ))}
          </select>
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
      {check && (check.hard.length > 0 || check.soft.length > 0) ? (
        <div className={`dc-issue ${check.hard.length ? 'hard' : ''}`}>
          <AlertTriangle size={15} />
          <div>
            <strong>{check.hard.length ? 'This time does not work' : 'Check before saving'}</strong>
            {[...check.hard, ...check.soft].map((x) => (
              <p key={x}>{x}</p>
            ))}
            {!check.hard.length && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={override}
                  onChange={(e) => setOverride(e.target.checked)}
                />
                Schedule anyway (the reason below is recorded)
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
