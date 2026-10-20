'use client';
import { useEffect, useRef, useState } from 'react';
import { formatInTimeZone } from 'date-fns-tz';
import { eachDayOfInterval, parseISO, format } from 'date-fns';
import type { AppState, RequestItem } from '@/lib/types';
import {
  CalendarDays,
  Check,
  ChevronRight,
  Clock3,
  Download,
  Grid2X2,
  List,
  Mail,
  Plus,
  Search,
  Send,
  Users,
  X,
} from 'lucide-react';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { AvailabilityForm } from './forms';
import { Avatar, Badge, Empty, Field, fmt, names, Run } from './shared';
const requestTabs = [
  {
    id: 'decide',
    label: 'Needs decision',
    statuses: ['Potential Match', 'Awaiting Banker Approval', 'Conflict', 'Alternative Slots Available'],
  },
  { id: 'waiting', label: 'Waiting on issuer', statuses: ['Awaiting Issuer Availability'] },
  { id: 'confirmed', label: 'Confirmed', statuses: ['Confirmed'] },
  { id: 'cancelled', label: 'Cancelled', statuses: ['Cancelled'] },
  { id: 'all', label: 'All', statuses: [] as string[] },
] as const;
/** Plain-language status so nobody has to decode workflow states. */
export function requestStatus(r: RequestItem, role: string) {
  const sales = role === 'SALES';
  switch (r.status) {
    case 'Potential Match':
      return { tone: 'green', text: 'Time is open', hint: sales ? 'Banker to confirm' : 'Ready to confirm' };
    case 'Awaiting Banker Approval':
      return { tone: 'green', text: 'Time is open', hint: sales ? 'Banker to confirm' : 'Ready to confirm' };
    case 'Conflict':
      return { tone: 'red', text: 'Time is taken', hint: r.alternatives.length ? `${r.alternatives.length} open times` : 'No open times' };
    case 'Alternative Slots Available':
      return { tone: 'amber', text: 'Pick another time', hint: `${r.alternatives.length} open times` };
    case 'Awaiting Issuer Availability':
      return { tone: 'blue', text: 'Waiting on issuer', hint: 'Availability not in yet' };
    case 'Confirmed':
      return { tone: 'green', text: 'Confirmed', hint: '' };
    case 'Cancelled':
      return { tone: '', text: 'Cancelled', hint: '' };
    default:
      return { tone: '', text: r.status, hint: '' };
  }
}
export function RequestsView({
  data,
  conferenceId,
  search,
  run,
  onNew,
  onOpen,
}: {
  data: AppState;
  conferenceId: string;
  search: string;
  run: Run;
  onNew: () => void;
  onOpen: (id: string) => void;
}) {
  const sales = data.user.role === 'SALES';
  const [tab, setTab] = useState<(typeof requestTabs)[number]['id']>(sales ? 'all' : 'decide');
  const n = names(data),
    c = data.conferences.find((c) => c.id === conferenceId)!;
  const base = data.requests.filter(
    (r) =>
      r.conferenceId === conferenceId &&
      `${n.issuer(r.issuerId)} ${n.investor(r.investorId)} ${r.status}`.toLowerCase().includes(search.toLowerCase()),
  );
  const inTab = (id: string, r: RequestItem) => {
    const t = requestTabs.find((t) => t.id === id)!;
    return !t.statuses.length || (t.statuses as readonly string[]).includes(r.status);
  };
  const requests = base.filter((r) => inTab(tab, r)).sort((x, y) => x.start.localeCompare(y.start));
  const cta = (r: RequestItem) => {
    if (sales || ['Confirmed', 'Cancelled'].includes(r.status)) return 'View';
    if (['Conflict', 'Alternative Slots Available'].includes(r.status)) return 'Pick a time';
    if (r.status === 'Awaiting Issuer Availability') return 'Email issuer';
    return 'Confirm';
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{sales ? 'Your meeting requests' : 'Meeting requests'}</h1>
          <p>
            {sales
              ? 'Type one line and Corda finds the time. Your banker confirms with the issuer.'
              : `${base.filter((r) => inTab('decide', r)).length} need your decision`}
          </p>
        </div>
        <Button onClick={onNew}>
          <Plus size={16} />
          New request
        </Button>
      </div>
      <div className="panel">
        {sales && <QuickRequest data={data} conferenceId={conferenceId} run={run} />}
        <div className="status-tabs" role="tablist" aria-label="Request status">
          {requestTabs.map((t) => {
            const count = base.filter((r) => inTab(t.id, r)).length;
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={tab === t.id ? 'active' : ''}
                onClick={() => setTab(t.id)}
              >
                {sales && t.id === 'decide' ? 'With banker' : t.label}
                <span className={`tab-count ${t.id === 'decide' && count && !sales ? 'hot' : ''}`}>{count}</span>
              </button>
            );
          })}
        </div>
        {requests.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Investor → issuer</th>
                  <th>Requested time</th>
                  <th>Status</th>
                  <th>{sales ? 'Coverage banker' : 'Requested by'}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => {
                  const st = requestStatus(r, data.user.role);
                  return (
                    <tr className="clickable" key={r.id} onClick={() => onOpen(r.id)}>
                      <td>
                        <div className="entity-cell">
                          <Avatar
                            name={n.issuer(r.issuerId)}
                            color={data.issuers.find((i) => i.id === r.issuerId)?.color}
                          />
                          <div>
                            <strong>{n.investor(r.investorId)}</strong>
                            <small>with {n.issuer(r.issuerId)}</small>
                          </div>
                        </div>
                      </td>
                      <td>
                        <div className="req-when">
                          <strong>{fmt(r.start, c.timezone, 'EEE, MMM d')}</strong>
                          <small>
                            {fmt(r.start, c.timezone, 'h:mm a')} – {fmt(r.end, c.timezone, 'h:mm a')}
                          </small>
                        </div>
                      </td>
                      <td>
                        <span className={`req-status ${st.tone}`}>
                          <i />
                          <span>
                            {st.text}
                            {st.hint && <small style={{ display: 'block' }}>{st.hint}</small>}
                          </span>
                        </span>
                      </td>
                      <td>{n.user(sales ? r.bankerId : r.salespersonId)}</td>
                      <td>
                        <div className="req-actions">
                          <Button
                            size="sm"
                            variant={cta(r) === 'View' ? 'ghost' : cta(r) === 'Confirm' ? 'default' : 'outline'}
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpen(r.id);
                            }}
                          >
                            {cta(r)} <ChevronRight size={13} />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title={tab === 'decide' ? 'No decisions waiting' : 'Nothing in this tab'}
            description={
              sales
                ? 'Type a request above, e.g. “Ally Financial / Vanguard 2-3pm Tuesday”.'
                : 'New requests from sales land in “Needs decision”.'
            }
          />
        )}
        <div className="table-footer">
          An open time is a match, not a confirmation, until the banker confirms.<span>{c.timezone}</span>
        </div>
      </div>
    </>
  );
}
type Parsed = {
  parsed: {
    issuerId: string | null;
    investorId: string | null;
    date: string | null;
    windowStart: string | null;
    windowEnd: string | null;
    duration: number;
    missing: string[];
  };
  proposal: { start: string; end: string; status: string; alternatives: { start: string; end: string }[] } | null;
};
/** One-sentence request entry for sales: "Issuer / Investor 3-4pm Monday". */
function QuickRequest({ data, conferenceId, run }: { data: AppState; conferenceId: string; run: Run }) {
  const [text, setText] = useState(''),
    [result, setResult] = useState<Parsed | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const n = names(data),
    c = data.conferences.find((x) => x.id === conferenceId)!;
  async function check() {
    if (text.trim().length < 3) return;
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'parseRequest', data: { text, conferenceId } }),
      });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error);
      setResult(out.result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that request');
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    if (!result?.proposal || !result.parsed.issuerId || !result.parsed.investorId) return;
    setBusy(true);
    const ok = await run(
      'request',
      {
        conferenceId,
        issuerId: result.parsed.issuerId,
        investorId: result.parsed.investorId,
        start: result.proposal.start,
        end: result.proposal.end,
        duration: result.parsed.duration,
        notes: text,
      },
      'Request sent to the coverage banker.',
    );
    setBusy(false);
    if (ok) {
      setText('');
      setResult(null);
    }
  }
  const p = result?.parsed;
  return (
    <>
      <form
        className="quick-request"
        onSubmit={(e) => {
          e.preventDefault();
          void (result?.proposal ? submit() : check());
        }}
      >
        <Search size={15} color="#8a968c" />
        <input
          aria-label="Describe the meeting in one line"
          placeholder="e.g. Ally Financial / Vanguard 2-3pm Tuesday"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setResult(null);
          }}
        />
        <Button size="sm" disabled={busy || text.trim().length < 3} type="submit">
          {result?.proposal ? (
            <>
              <Send size={13} /> Send request
            </>
          ) : (
            'Find a time'
          )}
        </Button>
      </form>
      {(result || error) && (
        <div className="quick-preview" aria-live="polite">
          {error && <span className="warn">{error}</span>}
          {p && (
            <>
              <span>
                Issuer <b>{p.issuerId ? n.issuer(p.issuerId) : '—'}</b>
              </span>
              <span>
                Investor <b>{p.investorId ? n.investor(p.investorId) : '—'}</b>
              </span>
              {result?.proposal && (
                <span>
                  Best time <b>{fmt(result.proposal.start, c.timezone, 'EEE h:mm a')}</b> ·{' '}
                  {result.proposal.status === 'Potential Match' ? 'open on both calendars' : result.proposal.status.toLowerCase()}
                </span>
              )}
              {p.missing.length > 0 && <span className="warn">Add: {p.missing.join(', ')}</span>}
            </>
          )}
        </div>
      )}
    </>
  );
}
export function RequestDetail({
  r,
  data,
  close,
  run,
}: {
  r: RequestItem;
  data: AppState;
  close: () => void;
  run: Run;
}) {
  const [consent, setConsent] = useState(false),
    [location, setLocation] = useState(''),
    [purpose, setPurpose] = useState('Availability inquiry'),
    [busy, setBusy] = useState(false);
  const n = names(data),
    c = data.conferences.find((c) => c.id === r.conferenceId)!;
  async function doRun(type: string, p: unknown, msg: string) {
    setBusy(true);
    try {
      if (await run(type, p, msg)) close();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && close()}
      title={`${n.issuer(r.issuerId)} × ${n.investor(r.investorId)}`}
      description={`${c.name} · ${c.timezone}`}
    >
      <div className="form-grid">
        <Badge>{r.status}</Badge>
        <div className="request-slot">
          <CalendarDays size={20} />
          <div>
            <strong>{fmt(r.start, c.timezone, 'EEEE, MMMM d')}</strong>
            <p>
              {fmt(r.start, c.timezone, 'h:mm a')} – {fmt(r.end, c.timezone, 'h:mm a')} ·{' '}
              {r.duration} minutes
            </p>
          </div>
        </div>
        <div className="two-cols">
          <div>
            <small className="muted">Coverage banker</small>
            <p>{n.user(r.bankerId)}</p>
          </div>
          <div>
            <small className="muted">Requested by</small>
            <p>{n.user(r.salespersonId)}</p>
          </div>
        </div>
        {r.notes && <p className="notice">{r.notes}</p>}
        {r.alternativeDates.length > 0 && (
          <p className="muted">Alternative preferences: {r.alternativeDates.join(', ')}</p>
        )}
        {r.alternatives.length > 0 && (
          <div>
            <h4 className="mini-title">Available alternatives</h4>
            <div className="alternative-list">
              {r.alternatives.map((s, i) => (
                <button
                  disabled={busy}
                  key={i}
                  onClick={() =>
                    doRun(
                      'alternative',
                      { id: r.id, start: s.start },
                      'Alternative selected. Banker approval still required.',
                    )
                  }
                >
                  <Clock3 size={14} />
                  {fmt(s.start, c.timezone)} – {fmt(s.end, c.timezone, 'h:mm a')}
                  <ChevronRight size={14} />
                </button>
              ))}
            </div>
          </div>
        )}
        {data.user.role === 'BANKER' && !['Confirmed', 'Cancelled'].includes(r.status) && (
          <>
            <Field label="Meeting location">
              <input
                placeholder="e.g. Ocean Tower · 201"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
              />
            </Field>
            <label className="check notice">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              I have verified issuer consent and approve this meeting.
            </label>
            <Button
              disabled={!consent || busy}
              onClick={() =>
                doRun(
                  'confirm',
                  { id: r.id, location, consent },
                  'Meeting confirmed. Planner updated and confirmation draft prepared.',
                )
              }
            >
              <Check size={16} />
              Approve & confirm meeting
            </Button>
          </>
        )}
        <div className="divider-label">communication</div>
        <Field label="Draft purpose">
          <select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
            {[
              'Availability inquiry',
              'Alternative time proposal',
              'Meeting confirmation',
              'Reschedule request',
              'Cancellation',
            ].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </Field>
        <Button
          disabled={busy}
          variant="outline"
          onClick={() =>
            doRun('requestDraft', { id: r.id, purpose }, 'Communication draft created')
          }
        >
          <Mail size={15} />
          Create draft
        </Button>
        {!['Confirmed', 'Cancelled'].includes(r.status) && (
          <Button
            disabled={busy}
            variant="ghost"
            onClick={() => doRun('cancelRequest', { id: r.id }, 'Request cancelled')}
          >
            Cancel this request
          </Button>
        )}
        <small className="muted">Last updated {fmt(r.updatedAt, c.timezone)}</small>
      </div>
    </Dialog>
  );
}
export function AvailabilityView({
  data,
  conferenceId,
  search,
  run,
  onEmail,
}: {
  data: AppState;
  conferenceId: string;
  search: string;
  run: Run;
  onEmail: (id: string) => void;
}) {
  const [selected, setSelected] = useState(data.issuers[0].id),
    [editing, setEditing] = useState(false);
  const c = data.conferences.find((c) => c.id === conferenceId)!,
    n = names(data),
    issuer = data.issuers.find((i) => i.id === selected)!;
  const issuers = data.issuers.filter((i) => i.name.toLowerCase().includes(search.toLowerCase()));
  const av = data.availability.filter(
      (a) => a.conferenceId === conferenceId && a.issuerId === selected,
    ),
    meetings = data.meetings.filter(
      (m) => m.conferenceId === conferenceId && m.issuerId === selected && m.status !== 'Cancelled',
    ),
    requests = data.requests.filter(
      (r) =>
        r.conferenceId === conferenceId &&
        r.issuerId === selected &&
        !['Cancelled', 'Confirmed'].includes(r.status),
    );
  const days = eachDayOfInterval({ start: parseISO(c.startDate), end: parseISO(c.endDate) });
  const slots =
    data.slots.find((s) => s.conferenceId === conferenceId && s.issuerId === selected)?.slots || [];
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Issuer availability</h1>
          <p>{issuers.length} issuers</p>
        </div>
        <div className="availability-heading-actions">
          <select value={selected} onChange={(event) => setSelected(event.target.value)} aria-label="Select issuer">
            {issuers.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
          </select>
          {data.user.role === 'BANKER' && (
            <Button onClick={() => setEditing(true)}><Plus size={16} />Manage</Button>
          )}
        </div>
      </div>
      <div className="panel availability-panel">
        <div className="panel-heading">
          <div className="entity-cell">
            <Avatar name={issuer.name} color={issuer.color} />
            <div>
              <h3>{issuer.name}</h3>
              <p>
                {n.user(issuer.ownerId)} · {requests.length} pending
              </p>
            </div>
          </div>
          <div className="legend">
            <span>
              <i className="green-dot" />
              Available
            </span>
            <span>
              <i className="blue-dot" />
              Confirmed
            </span>
            <span>
              <i className="amber-dot" />
              Hold / blocked
            </span>
          </div>
        </div>
        <div className="availability-days">
          {days.map((day) => {
            const date = format(day, 'yyyy-MM-dd');
            return (
              <section key={date}>
                <div className="day-heading">
                  <strong>{format(day, 'EEEE')}</strong>
                  <span>{format(day, 'MMM d')}</span>
                </div>
                <div className="day-content">
                  {av
                    .filter((a) => fmt(a.start, c.timezone, 'yyyy-MM-dd') === date)
                    .map((a) => (
                      <div
                        key={a.id}
                        className={`availability-window ${a.kind !== 'Available' ? 'hold' : ''}`}
                      >
                        <div>
                          <strong>
                            {fmt(a.start, c.timezone, 'h:mm a')} –{' '}
                            {fmt(a.end, c.timezone, 'h:mm a')}
                          </strong>
                          <small>{a.kind === 'Available' ? 'Approved availability' : a.kind}</small>
                        </div>
                        {data.user.role === 'BANKER' && (
                          <button
                            title={a.kind === 'Hold' ? 'Release hold' : 'Remove window'}
                            aria-label={`Remove ${a.kind} ${fmt(a.start, c.timezone)}`}
                            onClick={() =>
                              run('release', { id: a.id }, 'Window released; requests recalculated')
                            }
                          >
                            <X size={13} />
                          </button>
                        )}
                        {'sourceEmailId' in a &&
                          typeof a.sourceEmailId === 'string' &&
                          a.sourceEmailId && (
                            <button
                              className="source-link"
                              onClick={() => onEmail(String(a.sourceEmailId))}
                            >
                              Source email ↗
                            </button>
                          )}
                      </div>
                    ))}
                  {meetings
                    .filter((m) => fmt(m.start, c.timezone, 'yyyy-MM-dd') === date)
                    .map((m) => (
                      <div className="meeting-window" key={m.id}>
                        <strong>
                          {fmt(m.start, c.timezone, 'h:mm a')} – {fmt(m.end, c.timezone, 'h:mm a')}
                        </strong>
                        <p>{n.investor(m.investorId)}</p>
                        <span>
                          {m.status} · {m.location || 'Location TBC'}
                        </span>
                      </div>
                    ))}
                  {!av.some((a) => fmt(a.start, c.timezone, 'yyyy-MM-dd') === date) && (
                    <div className="day-empty">No approved availability</div>
                  )}
                  <div className="day-slot-count">
                    {slots.filter((s) => fmt(s.start, c.timezone, 'yyyy-MM-dd') === date).length}{' '}
                    available {c.slotMinutes}-minute slots
                  </div>
                </div>
              </section>
            );
          })}
        </div>
        <div className="table-footer">
          Last updated:{' '}
          {av.length
            ? fmt(
                [...av].sort((a, b) =>
                  String('updatedAt' in b ? b.updatedAt : '').localeCompare(
                    String('updatedAt' in a ? a.updatedAt : ''),
                  ),
                )[0].updatedAt || new Date().toISOString(),
                c.timezone,
              )
            : 'No approved windows'}
          <span>{c.timezone}</span>
        </div>
      </div>
      {editing && (
        <AvailabilityForm
          key={`${conferenceId}-${selected}`}
          data={data}
          conferenceId={conferenceId}
          issuerId={selected}
          open
          close={() => setEditing(false)}
          run={run}
        />
      )}
    </>
  );
}
export function PlannerView({
  data,
  conferenceId,
  search,
}: {
  data: AppState;
  conferenceId: string;
  search: string;
}) {
  const [view, setView] = useState('calendar'),
    [date, setDate] = useState(data.conferences.find((c) => c.id === conferenceId)!.startDate),
    [scope, setScope] = useState('master'),
    [audience, setAudience] = useState(''),
    [recipient, setRecipient] = useState(''),
    [selected, setSelected] = useState<string | null>(null);
  const c = data.conferences.find((c) => c.id === conferenceId)!,
    n = names(data);
  const meetings = data.meetings.filter(
    (m) =>
      m.conferenceId === conferenceId &&
      m.status === 'Confirmed' &&
      `${n.issuer(m.issuerId)} ${n.investor(m.investorId)}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (scope === 'master' ||
        (scope === 'issuer' && m.issuerId === audience) ||
        (scope === 'investor' && m.investorId === audience) ||
        (scope === 'banker' && data.coverageAssignments.some((a) => a.meetingId === m.id && a.bankerId === audience)) ||
        (scope === 'cube' && data.cubeAssignments.some((a) => a.meetingId === m.id && a.cubeId === audience))),
  );
  const active = meetings.find((m) => m.id === selected);
  const days = eachDayOfInterval({ start: parseISO(c.startDate), end: parseISO(c.endDate) });
  const exportUrl = `/api/export?conferenceId=${conferenceId}&scope=${scope}${audience ? `&id=${audience}` : ''}${recipient ? `&recipient=${encodeURIComponent(recipient)}` : ''}`;
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Schedule</h1>
          <p>
            {meetings.length} confirmed meeting{meetings.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="resource-actions">
          <Button variant="outline" asChild><a href={`${exportUrl}&format=pdf`}><Download size={16} />Export PDF</a></Button>
          <Button asChild><a href={exportUrl}><Download size={16} />Export Excel</a></Button>
        </div>
      </div>
      <div className="panel">
        <div className="panel-toolbar planner-toolbar">
          <div className="flex flex-wrap items-center gap-2">
            <div className="seg" role="tablist" aria-label="Whose schedule">
              {(
                [
                  ['master', 'Everyone'],
                  ...(data.user.role === 'BANKER'
                    ? ([
                        ['banker', 'Banker'],
                        ['cube', 'Meeting room'],
                      ] as const)
                    : []),
                  ['issuer', 'Issuer'],
                  ['investor', 'Investor'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={scope === id}
                  className={scope === id ? 'active' : ''}
                  onClick={() => {
                    setScope(id);
                    setAudience(
                      id === 'issuer'
                        ? data.issuers[0].id
                        : id === 'investor'
                          ? data.investors[0].id
                          : id === 'banker'
                            ? (data.user.role === 'BANKER' ? data.user.id : data.users.find((u) => u.role === 'BANKER')?.id) || ''
                            : id === 'cube'
                              ? data.meetingCubes.find((cube) => cube.conferenceId === conferenceId)?.id || ''
                              : '',
                    );
                    setRecipient('');
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {scope !== 'master' && (
              <select
                className="compact-select"
                aria-label="Show schedule for"
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
              >
                {(scope === 'issuer' ? data.issuers : scope === 'investor' ? data.investors : scope === 'banker' ? data.users.filter((u) => u.role === 'BANKER') : data.meetingCubes.filter((cube) => cube.conferenceId === conferenceId)).map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="view-toggle">
            <button
              className={view === 'calendar' ? 'active' : ''}
              onClick={() => setView('calendar')}
            >
              <Grid2X2 size={14} />
              Calendar
            </button>
            <button className={view === 'table' ? 'active' : ''} onClick={() => setView('table')}>
              <List size={14} />
              Table
            </button>
          </div>
        </div>
        {['issuer', 'investor'].includes(scope) && (
          <div className="recipient-filter">
            <Field
              label="Recipient-specific export (optional)"
              hint="Only meetings with an approved recipient match will be exported."
            >
              <input
                placeholder="Approved recipient email address"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
              />
            </Field>
          </div>
        )}
        {view === 'table' ? (
          meetings.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Meeting</th>
                    <th>Date & time</th>
                    <th>Primary banker</th>
                    <th>Additional coverage</th>
                    <th>Meeting cube</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {meetings.map((m) => {
                    const coverage = data.coverageAssignments.filter((a) => a.meetingId === m.id);
                    const room = data.cubeAssignments.find((a) => a.meetingId === m.id);
                    const cube = data.meetingCubes.find((x) => x.id === room?.cubeId);
                    const requirement = data.coverageRequirements.find((r) => r.meetingId === m.id);
                    const warning = coverage.length < (requirement?.requiredBankerCount || 2) || (m.requiresCube && !room);
                    return (
                    <tr key={m.id} className="clickable" onClick={() => setSelected(m.id)}>
                      <td>
                        <strong>{n.issuer(m.issuerId)}</strong>
                        <small>{n.investor(m.investorId)}</small>
                      </td>
                      <td>
                        {fmt(m.start, c.timezone)}
                        <small>to {fmt(m.end, c.timezone, 'h:mm a')}</small>
                      </td>
                      <td>{coverage.filter((a) => a.coverageRole === 'Primary').map((a) => n.user(a.bankerId)).join(', ') || 'Unassigned'}</td>
                      <td>{coverage.filter((a) => a.coverageRole !== 'Primary').map((a) => n.user(a.bankerId)).join(', ') || '—'}</td>
                      <td>{cube?.name || m.location || 'Unassigned'}</td>
                      <td>
                        <Badge tone={warning ? 'amber' : 'green'}>{warning ? 'Needs resources' : m.status}</Badge>
                      </td>
                    </tr>
                  );})}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="No confirmed meetings"
              description="Approved meeting requests will appear here automatically."
            />
          )
        ) : scope === 'banker' ? (
          <BankerWeekCalendar
            data={data}
            conferenceId={conferenceId}
            bankerId={audience}
            meetings={meetings}
            onSelect={setSelected}
          />
        ) : (
          <>
            <div className="planner-days">
              {days.map((d) => (
                <button
                  key={String(d)}
                  className={date === format(d, 'yyyy-MM-dd') ? 'active' : ''}
                  onClick={() => setDate(format(d, 'yyyy-MM-dd'))}
                >
                  {format(d, 'EEE, MMM d')}{' '}
                  <small style={{ opacity: 0.7 }}>
                    {meetings.filter((m) => fmt(m.start, c.timezone, 'yyyy-MM-dd') === format(d, 'yyyy-MM-dd')).length}
                  </small>
                </button>
              ))}
              <span>{c.timezone}</span>
            </div>
            <div className="calendar-scroll">
              <div
                className="calendar-grid"
                style={{
                  gridTemplateColumns: `65px repeat(${data.issuers.length}, minmax(140px,1fr))`,
                }}
              >
                <div className="calendar-corner">TIME</div>
                {data.issuers.map((i) => (
                  <div className="calendar-issuer" key={i.id}>
                    <span style={{ background: i.color }} />
                    {i.name}
                  </div>
                ))}
                {Array.from({ length: 9 }, (_, i) => i + 9).map((hour) => (
                  <div className="calendar-row" key={hour}>
                    <div className="calendar-time">
                      {hour > 12 ? hour - 12 : hour} {hour >= 12 ? 'PM' : 'AM'}
                    </div>
                    {data.issuers.map((i) => (
                      <div className="calendar-cell" key={i.id}>
                        {meetings
                          .filter(
                            (m) =>
                              m.issuerId === i.id &&
                              fmt(m.start, c.timezone, 'yyyy-MM-dd') === date &&
                              Number(fmt(m.start, c.timezone, 'H')) === hour,
                          )
                          .map((m) => (
                            <button
                              onClick={() => setSelected(m.id)}
                              key={m.id}
                              className="calendar-event"
                              style={{ borderLeftColor: i.color, background: `${i.color}16` }}
                            >
                              <strong>{n.investor(m.investorId)}</strong>
                              <small>
                                {fmt(m.start, c.timezone, 'h:mm')} –{' '}
                                {fmt(m.end, c.timezone, 'h:mm a')}
                              </small>
                              <span>{m.location || 'Location TBC'}</span>
                            </button>
                          ))}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
        <div className="table-footer">
          <span>
            <i className="green-dot" /> {meetings.length} confirmed meetings
          </span>
          <span>Updates after every approved change</span>
        </div>
      </div>
      {active && (
        <Dialog
          open
          onOpenChange={(v) => !v && setSelected(null)}
          title={`${n.issuer(active.issuerId)} × ${n.investor(active.investorId)}`}
          description={`Meeting ${active.id}`}
        >
          <div className="form-grid">
            <Badge>{active.status}</Badge>
            <p>
              {fmt(active.start, c.timezone)} – {fmt(active.end, c.timezone, 'h:mm a')}
            </p>
            <p>
              {c.timezone} · {active.location || 'Location to be confirmed'}
            </p>
            <p>Bankers: {active.bankerIds.map(n.user).join(', ')}</p>
            <div className="notice">
              Approved recipients:{' '}
              {active.approvedRecipients.join(', ') || 'Pending recipient review in Communications'}
            </div>
            <Button variant="outline" asChild>
              <a
                href={`/api/export?conferenceId=${conferenceId}&scope=meeting&id=${active.id}&format=ics`}
              >
                <Download size={15} />
                Download calendar event
              </a>
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}

function BankerWeekCalendar({
  data,
  conferenceId,
  bankerId,
  meetings,
  onSelect,
}: {
  data: AppState;
  conferenceId: string;
  bankerId: string;
  meetings: AppState['meetings'];
  onSelect: (id: string) => void;
}) {
  const conference = data.conferences.find((c) => c.id === conferenceId)!;
  const n = names(data);
  const days = eachDayOfInterval({ start: parseISO(conference.startDate), end: parseISO(conference.endDate) });
  const startHour = 9;
  const endHour = 18;
  const slotHeight = 64;
  const slots = Array.from({ length: (endHour - startHour) * 2 }, (_, index) => index);
  const firstMinutes = meetings.length
    ? Math.min(...meetings.map((m) => Number(fmt(m.start, conference.timezone, 'H')) * 60 + Number(fmt(m.start, conference.timezone, 'm'))))
    : startHour * 60;
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = Math.max(0, ((firstMinutes - startHour * 60) / 30) * slotHeight - 24);
  }, [firstMinutes, bankerId]);
  const assignment = (meetingId: string) =>
    data.coverageAssignments.find((a) => a.meetingId === meetingId && a.bankerId === bankerId);
  return (
    <div className="banker-week">
      <div className="banker-week-summary">
        <div>
          <Avatar name={n.user(bankerId)} color="#436b5e" />
          <div>
            <strong>{n.user(bankerId)}’s coverage schedule</strong>
            <p>{meetings.length} approved meeting{meetings.length === 1 ? '' : 's'} · {conference.timezone}</p>
          </div>
        </div>
        <span><i className="green-dot" />Approved coverage only</span>
      </div>
      <div className="banker-week-scroll" ref={scrollRef}>
        <div className="banker-week-grid" style={{ gridTemplateColumns: `72px repeat(${days.length}, minmax(250px, 1fr))` }}>
          <div className="banker-week-corner">TIME</div>
          {days.map((day) => {
            const dateKey = format(day, 'yyyy-MM-dd');
            const count = meetings.filter((m) => fmt(m.start, conference.timezone, 'yyyy-MM-dd') === dateKey).length;
            return <div className="banker-day-heading" key={dateKey}><span>{format(day, 'EEE')}</span><strong>{format(day, 'MMM d')}</strong><small>{count} meeting{count === 1 ? '' : 's'}</small></div>;
          })}
          <div className="banker-time-column">
            {slots.map((slot) => <div className="banker-time-slot" key={slot}>{slot % 2 === 0 ? formatHour(startHour + slot / 2) : ''}</div>)}
          </div>
          {days.map((day) => {
            const dateKey = format(day, 'yyyy-MM-dd');
            const dayMeetings = meetings.filter((m) => fmt(m.start, conference.timezone, 'yyyy-MM-dd') === dateKey);
            return <div className="banker-day-column" key={dateKey} style={{ height: slots.length * slotHeight }}>
              {slots.map((slot) => <div className="banker-slot-line" key={slot} style={{ top: slot * slotHeight }} />)}
              {dayMeetings.map((meeting) => {
                const startMinutes = Number(fmt(meeting.start, conference.timezone, 'H')) * 60 + Number(fmt(meeting.start, conference.timezone, 'm'));
                const endMinutes = Number(fmt(meeting.end, conference.timezone, 'H')) * 60 + Number(fmt(meeting.end, conference.timezone, 'm'));
                const top = ((startMinutes - startHour * 60) / 30) * slotHeight;
                const height = Math.max(((endMinutes - startMinutes) / 30) * slotHeight - 5, 44);
                const issuer = data.issuers.find((i) => i.id === meeting.issuerId)!;
                const room = data.cubeAssignments.find((a) => a.meetingId === meeting.id);
                const cube = data.meetingCubes.find((x) => x.id === room?.cubeId);
                const role = assignment(meeting.id)?.coverageRole || 'Coverage';
                return <button key={meeting.id} title={`${n.issuer(meeting.issuerId)} × ${n.investor(meeting.investorId)} · ${cube?.name || meeting.location || 'Room TBC'}`} className={`banker-calendar-event ${height < 56 ? 'short' : ''}`} style={{ top: Math.max(top, 0), height, borderLeftColor: issuer.color, background: `${issuer.color}14` }} onClick={() => onSelect(meeting.id)}>
                  <small>{fmt(meeting.start, conference.timezone, 'h:mm')}–{fmt(meeting.end, conference.timezone, 'h:mm a')} · {cube?.name || meeting.location || 'Room TBC'}</small>
                  <div><strong>{n.issuer(meeting.issuerId)} <span style={{ fontWeight: 400, color: '#5d6f63' }}>× {n.investor(meeting.investorId)}</span></strong><Badge tone={role === 'Primary' ? 'green' : 'gray'}>{role}</Badge></div>
                </button>;
              })}
            </div>;
          })}
        </div>
      </div>
    </div>
  );
}

function formatHour(hour: number) {
  if (hour === 12) return '12 PM';
  return hour > 12 ? `${hour - 12} PM` : `${hour} AM`;
}
