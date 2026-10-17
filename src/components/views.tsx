'use client';
import { useState } from 'react';
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
export function RequestsView({
  data,
  conferenceId,
  search,
  run,
  onNew,
}: {
  data: AppState;
  conferenceId: string;
  search: string;
  run: Run;
  onNew: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null),
    [status, setStatus] = useState('All requests');
  const n = names(data),
    c = data.conferences.find((c) => c.id === conferenceId)!;
  const requests = data.requests.filter(
    (r) =>
      r.conferenceId === conferenceId &&
      `${n.issuer(r.issuerId)} ${n.investor(r.investorId)} ${r.status}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (status === 'All requests' || r.status === status),
  );
  const active = data.requests.find((r) => r.id === selected);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="section-eyebrow">MEETING COORDINATION</div>
          <h1>{data.user.role === 'SALES' ? 'Your meeting requests' : 'Meeting requests'}</h1>
          <p>From investor interest to an approved meeting, all in one place.</p>
        </div>
        <Button onClick={onNew}>
          <Plus size={16} />
          New request
        </Button>
      </div>
      <div className="panel">
        <div className="panel-toolbar">
          <div className="tab-buttons">
            <button className="active">
              Requests <span>{requests.length}</span>
            </button>
          </div>
          <select
            className="compact-select"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            {[
              'All requests',
              'Potential Match',
              'Alternative Slots Available',
              'Awaiting Issuer Availability',
              'Awaiting Banker Approval',
              'Confirmed',
              'Cancelled',
              'Conflict',
            ].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        {requests.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Issuer / investor</th>
                  <th>Preferred time</th>
                  <th>Status</th>
                  <th>Coverage banker</th>
                  <th>Priority</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr className="clickable" key={r.id} onClick={() => setSelected(r.id)}>
                    <td>
                      <div className="entity-cell">
                        <Avatar
                          name={n.issuer(r.issuerId)}
                          color={data.issuers.find((i) => i.id === r.issuerId)?.color}
                        />
                        <div>
                          <strong>{n.issuer(r.issuerId)}</strong>
                          <small>{n.investor(r.investorId)}</small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <strong>{fmt(r.start, c.timezone, 'EEE, MMM d')}</strong>
                      <small>
                        {fmt(r.start, c.timezone, 'h:mm a')} – {fmt(r.end, c.timezone, 'h:mm a')}
                      </small>
                    </td>
                    <td>
                      <Badge>{r.status}</Badge>
                      {r.alternatives.length > 0 && r.status !== 'Potential Match' && (
                        <small className="green-text">
                          {r.alternatives.length} alternative slots
                        </small>
                      )}
                    </td>
                    <td>{n.user(r.bankerId)}</td>
                    <td>
                      <Badge>{r.priority}</Badge>
                    </td>
                    <td>
                      <button
                        aria-label={`Review ${n.issuer(r.issuerId)} request`}
                        onClick={() => setSelected(r.id)}
                      >
                        <ChevronRight size={17} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="No requests here yet"
            description="Submit a meeting request to check approved issuer availability."
          />
        )}
        <div className="table-footer">
          Availability is a potential match, not a confirmation.<span>{c.timezone}</span>
        </div>
      </div>
      {active && (
        <RequestDetail
          key={active.id}
          r={active}
          data={data}
          close={() => setSelected(null)}
          run={run}
        />
      )}
    </>
  );
}
function RequestDetail({
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
          <div className="section-eyebrow">APPROVED AVAILABILITY</div>
          <h1>Issuer availability</h1>
          <p>A shared view of open windows, confirmed meetings, and holds.</p>
        </div>
        {data.user.role === 'BANKER' && (
          <Button onClick={() => setEditing(true)}>
            <Plus size={16} />
            Manage availability
          </Button>
        )}
      </div>
      <div className="issuer-cards">
        {issuers.map((i) => {
          const count =
            data.slots.find((s) => s.conferenceId === conferenceId && s.issuerId === i.id)?.slots
              .length || 0;
          return (
            <button
              className={`issuer-card ${selected === i.id ? 'selected' : ''}`}
              key={i.id}
              onClick={() => setSelected(i.id)}
            >
              <div className="flex items-center gap-3">
                <Avatar name={i.name} color={i.color} />
                <div>
                  <strong>{i.name}</strong>
                  <small>{i.sector}</small>
                </div>
              </div>
              <div className="issuer-card-bottom">
                <span className={count ? 'green-text' : ''}>
                  {count ? `${count} open slots` : 'Awaiting availability'}
                </span>
                <ChevronRight size={14} />
              </div>
            </button>
          );
        })}
      </div>
      <div className="panel availability-panel">
        <div className="panel-heading">
          <div className="entity-cell">
            <Avatar name={issuer.name} color={issuer.color} />
            <div>
              <h3>{issuer.name}</h3>
              <p>
                Coverage: {n.user(issuer.ownerId)} · {requests.length} pending requests
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
      (scope === 'master' || (scope === 'issuer' ? m.issuerId : m.investorId) === audience),
  );
  const active = meetings.find((m) => m.id === selected);
  const days = eachDayOfInterval({ start: parseISO(c.startDate), end: parseISO(c.endDate) });
  const exportUrl = `/api/export?conferenceId=${conferenceId}&scope=${scope}${audience ? `&id=${audience}` : ''}${recipient ? `&recipient=${encodeURIComponent(recipient)}` : ''}`;
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="section-eyebrow">ONE CONFERENCE. ONE SOURCE OF TRUTH.</div>
          <h1>Conference planner</h1>
          <p>Confirmed meetings, automatically kept in sync with approvals.</p>
        </div>
        <Button asChild>
          <a href={exportUrl}>
            <Download size={16} />
            Export Excel
          </a>
        </Button>
      </div>
      <div className="panel">
        <div className="panel-toolbar planner-toolbar">
          <div className="flex gap-2">
            <select
              className="compact-select"
              value={scope}
              onChange={(e) => {
                setScope(e.target.value);
                setAudience(
                  e.target.value === 'issuer'
                    ? data.issuers[0].id
                    : e.target.value === 'investor'
                      ? data.investors[0].id
                      : '',
                );
                setRecipient('');
              }}
            >
              <option value="master">Master planner · internal</option>
              <option value="issuer">Issuer-specific planner</option>
              <option value="investor">Investor-specific planner</option>
            </select>
            {scope !== 'master' && (
              <select
                className="compact-select"
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
              >
                {(scope === 'issuer' ? data.issuers : data.investors).map((i) => (
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
        {scope !== 'master' && (
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
                    <th>Location</th>
                    <th>Bankers</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {meetings.map((m) => (
                    <tr key={m.id} className="clickable" onClick={() => setSelected(m.id)}>
                      <td>
                        <strong>{n.issuer(m.issuerId)}</strong>
                        <small>{n.investor(m.investorId)}</small>
                      </td>
                      <td>
                        {fmt(m.start, c.timezone)}
                        <small>to {fmt(m.end, c.timezone, 'h:mm a')}</small>
                      </td>
                      <td>{m.location || 'TBC'}</td>
                      <td>{m.bankerIds.map(n.user).join(', ')}</td>
                      <td>
                        <Badge>{m.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="No confirmed meetings"
              description="Approved meeting requests will appear here automatically."
            />
          )
        ) : (
          <>
            <div className="planner-days">
              {days.map((d) => (
                <button
                  key={String(d)}
                  className={date === format(d, 'yyyy-MM-dd') ? 'active' : ''}
                  onClick={() => setDate(format(d, 'yyyy-MM-dd'))}
                >
                  {format(d, 'EEE, MMM d')}
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
