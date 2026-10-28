'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, EmailItem } from '@/lib/types';
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Building2,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  CircleHelp,
  Clock3,
  FileSpreadsheet,
  LayoutDashboard,
  Leaf,
  Loader2,
  Mail,
  MapPin,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Unplug,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { Avatar, Badge, Empty, Field, fmt, names, Run } from './shared';
import { EmailForm, RequestForm } from './forms';
import { DraftEditor, EmailReview } from './review';
import { Sheet } from './ui/sheet';
import { RequestDecision } from './decision';
import { AvailabilityView, PlannerView, RequestDetail, RequestsView } from './views';
import { ResourceAllocationView } from './resources';
const menu = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'queue', label: 'Action queue', icon: CheckCheck },
  { id: 'requests', label: 'Meeting requests', icon: Users },
  { id: 'schedule', label: 'Schedule', icon: CalendarDays },
  { id: 'allocation', label: 'Allocation', icon: SlidersHorizontal },
];

/* Every action is one of four schedule changes (how bankers talk about them) or "other". */
type KindId = 'new' | 'reschedule' | 'availability' | 'cancel' | 'other';
const kindOrder: KindId[] = ['new', 'reschedule', 'availability', 'cancel', 'other'];
const kindLabel: Record<KindId, string> = {
  new: 'New request',
  reschedule: 'Reschedule',
  availability: 'Availability',
  cancel: 'Cancel',
  other: 'Other',
};
type Action = AppState['actions'][number];
function actionKind(a: Action, data?: AppState): { id: KindId; label: string } {
  const t = a.type;
  const x = data?.emails.find((e) => e.id === a.emailId)?.proposal?.extraction as
    | { windows?: { kind: string }[] }
    | undefined;
  if (/inquiry/i.test(t) && x?.windows?.some((w) => w.kind === 'unavailable'))
    return { id: 'availability', label: 'Availability' };
  if (/reschedul/i.test(t)) return { id: 'reschedule', label: 'Reschedule' };
  if (/cancel/i.test(t)) return { id: 'cancel', label: 'Cancel' };
  if (/availability/i.test(t)) return { id: 'availability', label: 'Availability' };
  if (/resource/i.test(t)) return { id: 'other', label: 'Rooms' };
  if (/confirmation/i.test(t)) return { id: 'other', label: 'Confirmation' };
  if (/inquiry/i.test(t)) return { id: 'other', label: 'Question' };
  if (/request|alternative/i.test(t) || a.requestId) return { id: 'new', label: 'New request' };
  return { id: 'other', label: t };
}
/** The meeting time an action is about: the request's slot or the earliest window in the email proposal. */
function actionWhen(a: Action, data: AppState): string | null {
  const r = data.requests.find((x) => x.id === a.requestId);
  if (r) return r.start;
  const e = data.emails.find((x) => x.id === a.emailId);
  const w = (e?.proposal?.extraction as { windows?: { start: string }[] } | undefined)?.windows || [];
  return w.length ? [...w].sort((x, y) => x.start.localeCompare(y.start))[0].start : null;
}
function actionReceived(a: Action, data: AppState): string {
  return data.emails.find((x) => x.id === a.emailId)?.receivedAt || a.createdAt;
}
type SortMode = 'soonest' | 'received' | 'type';
function sortActions(list: Action[], data: AppState, mode: SortMode) {
  const far = '9999';
  return [...list].sort((a, b) => {
    if (mode === 'received') return actionReceived(b, data).localeCompare(actionReceived(a, data));
    if (mode === 'type') {
      const d = kindOrder.indexOf(actionKind(a, data).id) - kindOrder.indexOf(actionKind(b, data).id);
      if (d) return d;
    }
    return (actionWhen(a, data) || far).localeCompare(actionWhen(b, data) || far);
  });
}
function SortToggle({ value, onChange }: { value: SortMode; onChange: (m: SortMode) => void }) {
  return (
    <div className="sort-toggle" role="group" aria-label="Sort decisions">
      {([
        ['soonest', 'Meeting time'],
        ['received', 'Newest email'],
        ['type', 'Type'],
      ] as const).map(([id, label]) => (
        <button key={id} className={value === id ? 'active' : ''} aria-pressed={value === id} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}
function CordaMark() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none">
        <path d="M22.5 9.1a9.4 9.4 0 1 0 0 13.8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        <path d="M19.3 12.1a5.4 5.4 0 1 0 0 7.8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" opacity=".7" />
        <circle cx="23.1" cy="9.1" r="2.15" fill="currentColor" />
        <circle cx="23.1" cy="22.9" r="2.15" fill="currentColor" opacity=".7" />
      </svg>
    </div>
  );
}
export function Workspace() {
  const [data, setData] = useState<AppState | null>(null),
    [page, setPage] = useState('overview'),
    [conferenceId, setConferenceId] = useState('abs-east'),
    [search, setSearch] = useState(''),
    [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null),
    [error, setError] = useState(''),
    [emailOpen, setEmailOpen] = useState(false),
    [requestOpen, setRequestOpen] = useState(false),
    [reviewId, setReviewId] = useState<string | null>(null),
    [draftId, setDraftId] = useState<string | null>(null),
    [queueSection, setQueueSection] = useState<'tasks' | 'emails' | 'drafts'>('tasks'),
    [scheduleSection, setScheduleSection] = useState<'schedule' | 'availability'>('schedule'),
    [queueFocus, setQueueFocus] = useState<'all' | KindId>('all'),
    [overviewSort, setOverviewSort] = useState<SortMode>('soonest'),
    [help, setHelp] = useState(false),
    [busy, setBusy] = useState(false),
    [sheetRequestId, setSheetRequestId] = useState<string | null>(null),
    [outlookOpen, setOutlookOpen] = useState(false),
    [mobile, setMobile] = useState(false);
  const reload = useCallback(async () => {
    const response = await fetch('/api/state', { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    setData(result);
  }, []);
  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        const r = await fetch('/api/session'),
          s = await r.json();
        if (!s.user && s.demo && s.profiles?.length) {
          await fetch('/api/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId: s.profiles.find((p: { role: string }) => p.role === 'BANKER')?.id,
            }),
          });
        }
        if (!cancelled) await reload();
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Unable to load workspace');
      }
    }
    void init();
    const interval = setInterval(() => {
      void reload().catch(() => {});
    }, 10000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [reload]);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const state = q.get('outlook');
    if (!state) return;
    setToast(
      state === 'connected'
        ? { message: 'Outlook connected. New conference emails are in Email reviews.' }
        : { message: q.get('message') || 'Outlook sign-in did not finish.', error: true },
    );
    setOutlookOpen(true);
    history.replaceState(null, '', location.pathname);
  }, []);
  // Keep a linked inbox fresh while the workspace is open.
  const outlookLinked = Boolean(data?.outlook?.connected);
  useEffect(() => {
    if (!outlookLinked) return;
    const t = setInterval(() => {
      void fetch('/api/outlook/sync', { method: 'POST' })
        .then((r) => (r.ok ? reload() : undefined))
        .catch(() => {});
    }, 120000);
    return () => clearInterval(t);
  }, [outlookLinked, reload]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 6500);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  const run: Run = async (type, payload, message) => {
    setBusy(true);
    try {
      const response = await fetch('/api/commands', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, data: payload }),
        }),
        result = await response.json();
      if (!response.ok) throw new Error(result.error);
      await reload();
      setToast({ message: message || 'Changes saved' });
      return true;
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : 'Something went wrong', error: true });
      return false;
    } finally {
      setBusy(false);
    }
  };
  async function syncOutlook() {
    setBusy(true);
    try {
      const r = await fetch('/api/outlook/sync', { method: 'POST' });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error);
      await reload();
      setToast({
        message: out.imported
          ? `${out.imported} new conference email${out.imported === 1 ? '' : 's'} ready to review`
          : 'Inbox is up to date',
      });
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : 'Outlook sync failed', error: true });
    } finally {
      setBusy(false);
    }
  }
  function navigate(id: string) {
    if (id === 'inbox') {
      setPage('queue');
      setQueueSection('emails');
    } else if (id === 'drafts') {
      setPage('queue');
      setQueueSection('drafts');
    } else if (id === 'planner') {
      setPage('schedule');
      setScheduleSection('schedule');
    } else if (id === 'availability') {
      setPage('schedule');
      setScheduleSection('availability');
    } else if (id === 'resources') {
      setPage('allocation');
    } else {
      if (id === 'queue') setQueueSection('tasks');
      setPage(id);
    }
    setSearch('');
    setMobile(false);
  }
  async function switchUser(id: string) {
    try {
      const response = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: id }),
      });
      if (!response.ok) throw new Error('Could not switch demo profile.');
      setReviewId(null);
      setDraftId(null);
      setPage('overview');
      await reload();
    } catch (e) {
      setToast({ message: String(e), error: true });
    }
  }
  if (!data)
    return (
      <main className="loading-screen">
        <CordaMark />
        <h1>Corda AI</h1>
        {error ? (
          <>
            <p>{error}</p>
            <p>Run the database setup in the README, then refresh.</p>
            <Button onClick={() => location.reload()}>Retry</Button>
          </>
        ) : (
          <>
            <Loader2 className="spin" size={22} />
            <p>Preparing your workspace…</p>
          </>
        )}
      </main>
    );
  const banker = data.user.role === 'BANKER',
    c = data.conferences.find((c) => c.id === conferenceId)!,
    n = names(data),
    openActions = data.actions.filter(
      (a) => a.status === 'Open' && a.conferenceId === conferenceId,
    ),
    pendingEmails = data.emails.filter(
      (e) => e.status === 'Pending review' && e.conferenceId === conferenceId,
    ),
    reviewEmail = data.emails.find((e) => e.id === reviewId),
    sheetRequest = data.requests.find((r) => r.id === sheetRequestId),
    outlook = data.outlook,
    draft = data.drafts.find((d) => d.id === draftId);
  const confirmed = data.meetings.filter((m) => m.conferenceId === conferenceId && m.status === 'Confirmed');
  function actionClick(a: AppState['actions'][number]) {
    if (a.emailId) setReviewId(a.emailId);
    else if (a.requestId) setSheetRequestId(a.requestId);
    else if (a.type === 'Resource allocation') navigate('resources');
    else navigate('availability');
  }
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobile ? 'mobile-open' : ''}`}>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate('overview');
          }}
          className="brand"
        >
          <CordaMark />
          <span>Corda <span className="brand-ai">AI</span></span>
        </a>
        <div className="workspace-label">
          <div className="workspace-icon">
            <Building2 size={16} />
          </div>
          <div>
            <strong>Capital Markets</strong>
            <span>{banker ? 'Banker workspace' : 'Sales workspace'}</span>
          </div>
          <ChevronsUpDown size={14} />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {menu
            .filter((m) => banker || !['queue', 'allocation'].includes(m.id))
            .map((m) => (
              <button
                key={m.id}
                className={page === m.id ? 'nav-item active' : 'nav-item'}
                onClick={() => navigate(m.id)}
              >
                <m.icon size={18} strokeWidth={1.7} />
                <span>
                  {!banker && m.id === 'requests'
                    ? 'Request tracker'
                    : !banker && m.id === 'schedule'
                      ? 'Schedule'
                      : m.label}
                </span>
                {m.id === 'queue' && openActions.length > 0 && (
                  <span className="nav-count">{openActions.length}</span>
                )}
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          {banker && (
            <button className="outlook-pill" onClick={() => setOutlookOpen(true)}>
              <span className={`ol-dot ${outlook?.connected ? 'on' : ''}`} />
              <span>
                <strong>{outlook?.connected ? 'Outlook connected' : 'Connect Outlook'}</strong>
                <small>
                  {outlook?.connected
                    ? outlook.email || 'Inbox linked'
                    : outlook?.configured
                      ? 'Read and send real email'
                      : 'Using simulated email'}
                </small>
              </span>
            </button>
          )}
          <div className="ai-status">
            <div>
              <span className="live-dot" />
              <strong>Human-approved AI</strong>
              <Sparkles size={14} />
            </div>
            <p>
              Less coordination.
              <br />
              More meaningful conversations.
            </p>
          </div>
          <button className="nav-item" onClick={() => setHelp(true)}>
            <CircleHelp size={18} />
            <span>Help & workspace info</span>
          </button>
          {banker && (
            <button
              className={`nav-item ${page === 'audit' ? 'active' : ''}`}
              onClick={() => navigate('audit')}
            >
              <ShieldCheck size={18} strokeWidth={1.7} />
              <span>Audit trail</span>
            </button>
          )}
          <div className="profile">
            <Avatar name={data.user.name} color="#436b5e" />
            <div>
              <strong>{data.user.name}</strong>
              <span>{banker ? 'Investment Banking' : 'Institutional Sales'}</span>
            </div>
            {data.demo && (
              <select
                aria-label="Switch demo profile"
                value={data.user.id}
                onChange={(e) => switchUser(e.target.value)}
              >
                {data.users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} · {u.role === 'BANKER' ? 'Banker' : 'Sales'}
                  </option>
                ))}
              </select>
            )}
            <ChevronsUpDown size={14} />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button className="mobile-menu" onClick={() => setMobile(!mobile)}>
              <LayoutDashboard size={19} />
            </button>
            <span>{banker ? 'Banker workspace' : 'Sales workspace'}</span>
            <ChevronRight size={13} />
            <strong>
              {!banker && page === 'requests'
                ? 'Request tracker'
                : !banker && page === 'schedule'
                  ? 'Schedule'
                  : menu.find((m) => m.id === page)?.label || { audit: 'Audit trail' }[page]}
            </strong>
          </div>
          <div className="topbar-right">
            <div className="global-search">
              <Search size={15} />
              <input
                aria-label="Search current workspace view"
                placeholder="Search this view…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <span className="demo-badge">SYNTHETIC DATA</span>
            <button
              className="notification"
              aria-label="Open action queue"
              onClick={() => navigate(banker ? 'queue' : 'requests')}
            >
              <Bell size={18} />
              {openActions.length > 0 && <i />}
            </button>
            <Avatar name={data.user.name} color="#436b5e" size="small" />
          </div>
        </header>
        <main className="main-content">
          <div className="conference-bar">
            <div className="conference-picker">
              <CalendarDays size={16} />
              <select
                aria-label="Active conference"
                value={conferenceId}
                onChange={(e) => {
                  setConferenceId(e.target.value);
                  setSearch('');
                }}
              >
                {data.conferences.map((c) => (
                  <option value={c.id} key={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} />
              <span className="conference-date">
                {fmt(`${c.startDate}T12:00:00Z`, c.timezone, 'MMM d')}–
                {fmt(`${c.endDate}T12:00:00Z`, c.timezone, 'd, yyyy')}
              </span>
            </div>
            <div className="conference-location">
              <MapPin size={14} />
              {c.location}
              <span className="vertical-line" />
              <span className="live-dot" />
              Live workspace
            </div>
          </div>
          {page === 'queue' && banker && queueSection !== 'tasks' && (
            <div className="queue-backbar" aria-label="Action queue navigation">
              <button onClick={() => setQueueSection('tasks')}>
                <ChevronRight size={14} /> Back to action queue
              </button>
              <span>/</span>
              <strong>{queueSection === 'emails' ? 'Email reviews' : 'Draft communications'}</strong>
            </div>
          )}
          {page === 'schedule' && (
            <div className="workspace-subnav" aria-label="Schedule sections">
              <button className={scheduleSection === 'schedule' ? 'active' : ''} onClick={() => setScheduleSection('schedule')}>Meetings</button>
              <button className={scheduleSection === 'availability' ? 'active' : ''} onClick={() => setScheduleSection('availability')}>Issuer availability</button>
            </div>
          )}
          {page === 'overview' && (
            <>
              <div className="page-heading overview-heading">
                <div>
                  <h1>{c.name}</h1>
                  <p>
                    {banker ? `${openActions.length} decisions need attention.` : 'Your meeting activity.'}
                  </p>
                </div>
                <Button onClick={() => setRequestOpen(true)}>
                  <Plus size={16} />
                  New meeting request
                </Button>
              </div>
              <div className="stats-grid overview-stats">
                <Stat
                  icon={banker ? Sparkles : CheckCheck}
                  label={banker ? 'Needs your decision' : 'Potential matches'}
                  value={
                    banker
                      ? openActions.length
                      : data.requests.filter(
                          (r) => r.conferenceId === conferenceId && r.status === 'Potential Match',
                        ).length
                  }
                  foot={banker ? 'AI has done the groundwork' : 'Subject to banker approval'}
                  cta={banker ? 'Start reviewing' : 'See requests'}
                  onClick={() => {
                    setQueueFocus('all');
                    navigate(banker ? 'queue' : 'requests');
                  }}
                  tone="amber"
                />
                {banker ? (
                  <Stat
                    icon={Users}
                    label="New meeting requests"
                    value={openActions.filter((a) => actionKind(a, data).id === 'new').length}
                    foot="Investors and issuers asking to meet"
                    cta="Review new requests"
                    onClick={() => {
                      setQueueFocus('new');
                      navigate('queue');
                    }}
                    tone="blue"
                  />
                ) : (
                  <Stat
                    icon={Users}
                    label="Open meeting requests"
                    value={
                      data.requests.filter(
                        (r) => r.conferenceId === conferenceId && !['Confirmed', 'Cancelled'].includes(r.status),
                      ).length
                    }
                    foot="Investor conversations in motion"
                    cta="Open requests"
                    onClick={() => navigate('requests')}
                    tone="blue"
                  />
                )}
                <Stat
                  icon={CalendarDays}
                  label="Confirmed meetings"
                  value={confirmed.length}
                  foot="Approved and on the planner"
                  cta="Open schedule"
                  onClick={() => navigate('planner')}
                  tone="green"
                />
              </div>
              {banker ? (
                <div className="panel decide-panel">
                  <div className="panel-heading">
                    <div>
                      <h3>
                        Needs your decision <span className="count-pill">{openActions.length}</span>
                      </h3>
                    </div>
                    <div className="decide-tools">
                      <SortToggle value={overviewSort} onChange={setOverviewSort} />
                      <button
                        className="text-button"
                        onClick={() => {
                          setQueueFocus('all');
                          navigate('queue');
                        }}
                      >
                        View all <ArrowUpRight size={14} />
                      </button>
                    </div>
                  </div>
                  <DecisionStrip
                    actions={sortActions(
                      openActions.filter((a) =>
                        `${a.title} ${a.type} ${n.issuer(a.issuerId)} ${n.investor(a.investorId)}`
                          .toLowerCase()
                          .includes(search.toLowerCase()),
                      ),
                      data,
                      overviewSort,
                    )}
                    data={data}
                    zone={c.timezone}
                    onClick={actionClick}
                  />
                </div>
              ) : (
                <div className="panel">
                  <div className="panel-heading">
                    <div>
                      <h3>
                        Your recent requests{' '}
                        <span className="count-pill">
                          {data.requests.filter((r) => r.conferenceId === conferenceId).length}
                        </span>
                      </h3>
                    </div>
                    <button className="text-button" onClick={() => navigate('requests')}>
                      View all <ArrowUpRight size={14} />
                    </button>
                  </div>
                  <div className="recent-requests">
                    {data.requests
                      .filter((r) => r.conferenceId === conferenceId)
                      .slice(0, 5)
                      .map((r) => (
                        <button key={r.id} onClick={() => navigate('requests')}>
                          <Avatar
                            name={n.issuer(r.issuerId)}
                            color={data.issuers.find((i) => i.id === r.issuerId)?.color}
                          />
                          <div>
                            <strong>{n.issuer(r.issuerId)}</strong>
                            <small>{n.investor(r.investorId)}</small>
                          </div>
                          <Badge>{r.status}</Badge>
                        </button>
                      ))}
                    {!data.requests.some((r) => r.conferenceId === conferenceId) && (
                      <Empty
                        title="Start a conversation"
                        description="Create your first meeting request for this conference."
                      />
                    )}
                  </div>
                </div>
              )}
              <div className="panel issuer-overview">
                <div className="panel-heading">
                  <div>
                    <h3>Issuer readiness</h3>
                    <p>A quick pulse on your conference coverage.</p>
                  </div>
                  <button className="text-button" onClick={() => navigate('availability')}>
                    Manage availability <ArrowUpRight size={14} />
                  </button>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Issuer</th>
                        <th>Coverage banker</th>
                        <th>Availability</th>
                        <th>Confirmed meetings</th>
                        <th>Open slots</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {data.issuers
                        .filter((i) => i.name.toLowerCase().includes(search.toLowerCase()))
                        .slice(0, 5)
                        .map((i) => {
                          const slots =
                            data.slots.find(
                              (s) => s.issuerId === i.id && s.conferenceId === conferenceId,
                            )?.slots.length || 0;
                          return (
                            <tr key={i.id}>
                              <td>
                                <div className="entity-cell">
                                  <Avatar name={i.name} color={i.color} size="small" />
                                  <strong>{i.name}</strong>
                                </div>
                              </td>
                              <td>{n.user(i.ownerId)}</td>
                              <td>
                                <Badge tone={slots ? 'green' : 'amber'}>
                                  {slots ? 'Availability received' : 'Awaiting availability'}
                                </Badge>
                              </td>
                              <td>
                                {
                                  data.meetings.filter(
                                    (m) =>
                                      m.issuerId === i.id &&
                                      m.conferenceId === conferenceId &&
                                      m.status === 'Confirmed',
                                  ).length
                                }{' '}
                                meetings
                              </td>
                              <td>
                                <div className="slot-indicator">
                                  <span style={{ width: `${Math.min(100, slots * 2)}%` }} />
                                </div>
                                <span className="slot-number">{slots}</span>
                              </td>
                              <td>
                                <button
                                  aria-label={`View ${i.name} availability`}
                                  onClick={() => navigate('availability')}
                                >
                                  <ChevronRight size={15} />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
          {page === 'queue' && queueSection === 'emails' && (
            <InboxView
              data={data}
              conferenceId={conferenceId}
              search={search}
              onEmail={setReviewId}
              onAdd={() => setEmailOpen(true)}
              outlookConnected={Boolean(outlook?.connected)}
              onSync={syncOutlook}
              onConnect={() => setOutlookOpen(true)}
            />
          )}
          {page === 'queue' && queueSection === 'tasks' && (
            <QueueView
              data={data}
              conferenceId={conferenceId}
              search={search}
              onClick={actionClick}
              run={run}
              onOpenEmails={() => setQueueSection('emails')}
              onOpenDrafts={() => setQueueSection('drafts')}
              focus={queueFocus}
              setFocus={setQueueFocus}
            />
          )}
          {page === 'requests' && (
            <RequestsView
              data={data}
              conferenceId={conferenceId}
              search={search}
              run={run}
              onNew={() => setRequestOpen(true)}
              onOpen={setSheetRequestId}
            />
          )}
          {page === 'schedule' && scheduleSection === 'availability' && (
            <AvailabilityView
              key={conferenceId}
              data={data}
              conferenceId={conferenceId}
              search={search}
              run={run}
              onEmail={setReviewId}
            />
          )}
          {page === 'schedule' && scheduleSection === 'schedule' && (
            <PlannerView
              key={conferenceId}
              data={data}
              conferenceId={conferenceId}
              search={search}
            />
          )}
          {page === 'allocation' && banker && (
            <ResourceAllocationView
              key={conferenceId}
              data={data}
              conferenceId={conferenceId}
              run={run}
            />
          )}
          {page === 'queue' && queueSection === 'drafts' && (
            <>
              <div className="page-heading">
                <div>
                  <h1>Drafts</h1>
                  <p>{data.drafts.filter((d) => d.status === 'Draft').length} pending</p>
                </div>
                <Badge tone={outlook?.connected ? 'green' : 'amber'}>
                  {outlook?.connected ? `Sends from ${outlook.email}` : 'Simulated sending until Outlook is connected'}
                </Badge>
              </div>
              <div className="panel">
                {data.drafts.filter((d) => d.subject.toLowerCase().includes(search.toLowerCase()))
                  .length ? (
                  <div className="draft-list">
                    {data.drafts
                      .filter((d) => d.subject.toLowerCase().includes(search.toLowerCase()))
                      .map((d) => (
                        <button key={d.id} onClick={() => setDraftId(d.id)}>
                          <div className="mail-icon">
                            <Mail size={19} />
                          </div>
                          <div>
                            <strong>{d.subject}</strong>
                            <p>{d.to.join(', ') || 'Recipients need review'}</p>
                            <small>{d.body.slice(0, 110)}…</small>
                          </div>
                          <Badge>{d.status}</Badge>
                          <ChevronRight size={16} />
                        </button>
                      ))}
                  </div>
                ) : (
                  <Empty
                    title="Your next draft starts with a decision"
                    description="Confirm a meeting, request clarification, or create a communication from a meeting request."
                  />
                )}
              </div>
            </>
          )}
          {page === 'audit' && (
            <>
              <div className="page-heading">
                <div>
                  <h1>Audit trail</h1>
                  <p>{data.auditLogs.length} events</p>
                </div>
                <Badge tone="green">Database-backed history</Badge>
              </div>
              <div className="panel">
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Action</th>
                        <th>Actor</th>
                        <th>Entity</th>
                        <th>Timestamp</th>
                        <th>Change details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.auditLogs
                        .filter((a) =>
                          `${a.action} ${a.entityType}`
                            .toLowerCase()
                            .includes(search.toLowerCase()),
                        )
                        .map((a) => (
                          <tr key={a.id}>
                            <td>
                              <strong>{a.action}</strong>
                            </td>
                            <td>{n.user(a.actorId)}</td>
                            <td>
                              {a.entityType}
                              <small>{a.entityId}</small>
                            </td>
                            <td>{fmt(a.createdAt, c.timezone)}</td>
                            <td>
                              <details>
                                <summary>View history</summary>
                                <pre className="audit-json">
                                  {JSON.stringify({ before: a.before, after: a.after }, null, 2)}
                                </pre>
                              </details>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
          <footer className="workspace-footer">
            <span>
              <ShieldCheck size={13} />
              Human decisions. Connected workflows.
            </span>
            <span>
              Corda AI <span className="footer-dot">·</span> {c.timezone}
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className={`toast ${toast.error ? 'toast-error' : ''}`} role="status">
          {toast.error ? <X size={18} /> : <Check size={18} />}
          <span>{toast.message}</span>
          <button aria-label="Dismiss notification" onClick={() => setToast(null)}>
            <X size={15} />
          </button>
        </div>
      )}
      {busy && (
        <div className="saving">
          <Loader2 size={13} className="spin" />
          Saving changes
        </div>
      )}
      {emailOpen && <EmailForm open close={() => setEmailOpen(false)} run={run} reload={reload} />}
      {requestOpen && (
        <RequestForm
          data={data}
          conferenceId={conferenceId}
          open
          close={() => setRequestOpen(false)}
          run={run}
        />
      )}
      {reviewEmail && (
        <EmailReview
          key={reviewEmail.id}
          email={reviewEmail}
          data={data}
          close={() => setReviewId(null)}
          run={run}
          onOpenDraft={setDraftId}
        />
      )}
      {sheetRequest && banker && !['Confirmed', 'Cancelled'].includes(sheetRequest.status) && (
        <Sheet
          open
          onOpenChange={(v) => !v && setSheetRequestId(null)}
          title={`${n.investor(sheetRequest.investorId)} × ${n.issuer(sheetRequest.issuerId)}`}
          description="Decide here. The list stays where you left it."
        >
          <RequestDecision
            key={sheetRequest.id}
            request={sheetRequest}
            data={data}
            run={run}
            onDone={() => setSheetRequestId(null)}
            onOpenDraft={(id) => {
              setSheetRequestId(null);
              setDraftId(id);
            }}
          />
        </Sheet>
      )}
      {sheetRequest && (!banker || ['Confirmed', 'Cancelled'].includes(sheetRequest.status)) && (
        <RequestDetail
          key={sheetRequest.id}
          r={sheetRequest}
          data={data}
          close={() => setSheetRequestId(null)}
          run={run}
        />
      )}
      <Dialog
        open={outlookOpen}
        onOpenChange={setOutlookOpen}
        title="Outlook"
        description="Corda reads conference emails from your inbox and sends approved drafts from your address."
      >
        <div className="form-grid">
          <div className="outlook-status">
            <span className={`ol-dot ${outlook?.connected ? 'on' : ''}`} style={{ width: 10, height: 10, borderRadius: 99, background: outlook?.connected ? '#2f8a5f' : '#b9c2b8' }} />
            <div style={{ flex: 1 }}>
              <strong>{outlook?.connected ? `Connected as ${outlook.email}` : 'Not connected'}</strong>
              <p>
                {outlook?.connected
                  ? outlook.lastSyncAt
                    ? `Last sync ${fmt(outlook.lastSyncAt, undefined, 'MMM d, h:mm a')} · ${outlook.lastSyncCount} new`
                    : 'Not synced yet'
                  : outlook?.configured
                    ? 'Sign in with your Microsoft account to link your inbox.'
                    : 'No Azure app is set up yet, so mail is simulated.'}
              </p>
              {outlook?.lastError && <p style={{ color: 'var(--warn)' }}>{outlook.lastError}</p>}
            </div>
            {outlook?.connected ? (
              <div className="dc-actions">
                <Button size="sm" onClick={syncOutlook} disabled={busy}>
                  <RefreshCw size={13} /> Sync now
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await fetch('/api/outlook/disconnect', { method: 'POST' });
                    await reload();
                    setToast({ message: 'Outlook disconnected. Mail is simulated again.' });
                  }}
                >
                  <Unplug size={13} /> Disconnect
                </Button>
              </div>
            ) : (
              outlook?.configured && (
                <Button size="sm" onClick={() => (location.href = '/api/outlook/connect')}>
                  Connect
                </Button>
              )
            )}
          </div>
          {!outlook?.configured && (
            <>
              <strong>Set up once (about 5 minutes)</strong>
              <ol className="outlook-steps">
                <li>
                  Open <code>portal.azure.com</code> → <b>App registrations</b> → <b>New registration</b>.
                </li>
                <li>
                  Account type: <b>Personal Microsoft accounts only</b>. Redirect URI:{' '}
                  <code>http://localhost:3000/api/outlook/callback</code>
                </li>
                <li>
                  Platform: <b>Mobile and desktop applications</b> (no client secret needed).
                </li>
                <li>
                  <b>API permissions</b> → Microsoft Graph → Delegated: <code>Mail.Read</code>, <code>Mail.Send</code>,{' '}
                  <code>User.Read</code>, <code>offline_access</code>.
                </li>
                <li>
                  Put <code>MS_CLIENT_ID</code> and <code>MS_TENANT=consumers</code> in{' '}
                  <code>.env</code>, restart, then click Connect.
                </li>
              </ol>
            </>
          )}
          <p className="muted">
            Corda only imports emails that look conference-related and never sends anything until you press Send on a
            draft.
          </p>
        </div>
      </Dialog>
      {draft && (
        <DraftEditor
          key={draft.id}
          draft={draft}
          data={data}
          close={() => setDraftId(null)}
          run={run}
        />
      )}
      <Dialog
        open={help}
        onOpenChange={setHelp}
        title="Your Corda AI workspace"
        description="A local MVP for investment banking conference coordination."
      >
        <div className="form-grid">
          <div className="notice">
            <strong>Demo identities</strong>
            <p>
              Use the profile selector in the sidebar to switch between two bankers and two
              salespeople. Sales can access only their own requests and authorized meetings.
            </p>
          </div>
          <p>
            <strong>Email processing:</strong> {data.parser}
          </p>
          <p>
            <strong>Source of truth:</strong> PostgreSQL through Prisma. Excel files are
            import/export artifacts.
          </p>
          <p>
            <strong>Time handling:</strong> Dates are interpreted in each conference’s IANA
            timezone.
          </p>
          <p>
            <strong>Delivery:</strong>{' '}
            {outlook?.connected
              ? `Approved drafts are sent from ${outlook.email} through Outlook and audited.`
              : 'Sends are simulated and audited until you connect Outlook.'}
          </p>
          <p>
            <strong>Updates:</strong> Views refresh automatically every 10 seconds.
          </p>
          <p className="muted">
            All organizations, contacts, meetings, and email content in this demo are synthetic.
            Enterprise SSO and Microsoft tenant approval are required before production use.
          </p>
        </div>
      </Dialog>
    </div>
  );
}
function Stat({
  icon: Icon,
  label,
  value,
  foot,
  tone,
  cta,
  onClick,
}: {
  icon: typeof CalendarDays;
  label: string;
  value: number;
  foot: string;
  tone: string;
  cta?: string;
  onClick?: () => void;
}) {
  return (
    <button className="stat-card" onClick={onClick}>
      <div>
        <span>{label}</span>
        <Icon size={17} strokeWidth={1.6} />
      </div>
      <strong>
        {value}
        <span className={`stat-accent ${tone}`} />
      </strong>
      <p>{foot}</p>
      {cta && (
        <span className="stat-cta">
          {cta} <ArrowRight size={13} />
        </span>
      )}
    </button>
  );
}
function DecisionStrip({
  actions,
  data,
  zone,
  onClick,
}: {
  actions: Action[];
  data: AppState;
  zone: string;
  onClick: (a: Action) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const n = names(data);
  if (!actions.length)
    return (
      <Empty
        title="You’re all caught up"
        description="New email proposals and meeting requests will appear here."
      />
    );
  const scroll = (dir: number) =>
    track.current?.scrollBy({ left: dir * Math.max(280, track.current.clientWidth * 0.8), behavior: 'smooth' });
  return (
    <div className="decide-strip">
      <button className="strip-arrow left" aria-label="Previous decisions" onClick={() => scroll(-1)}>
        <ChevronLeft size={16} />
      </button>
      <div className="decide-track" ref={track}>
        {actions.map((a) => {
          const kind = actionKind(a, data);
          const email = data.emails.find((e) => e.id === a.emailId);
          const when = actionWhen(a, data);
          const issuer = n.issuer(a.issuerId);
          const investor = n.investor(a.investorId);
          const what = email ? proposalLine(email, zone) : when ? fmt(when, zone, 'EEE, MMM d \u00b7 h:mm a') : null;
          return (
            <button className={`decide-card kind-${kind.id}`} key={a.id} onClick={() => onClick(a)}>
              <span className={`kind-tag kind-${kind.id}`}>{kind.label}</span>
              <strong>{issuer === 'Unassociated' ? a.title : issuer}</strong>
              {issuer !== 'Unassociated' && investor !== '—' && <span className="decide-with">with {investor}</span>}
              <span className="decide-what">{what || a.recommendation}</span>
              <span className="decide-foot">
                <span>{fmt(actionReceived(a, data), zone, 'MMM d, h:mm a')}</span>
                <ChevronRight size={14} />
              </span>
            </button>
          );
        })}
      </div>
      <button className="strip-arrow right" aria-label="More decisions" onClick={() => scroll(1)}>
        <ChevronRight size={16} />
      </button>
    </div>
  );
}
const emailTabs = [
  { id: 'review', label: 'Needs review', match: (s: string) => s === 'Pending review' },
  { id: 'waiting', label: 'Waiting on reply', match: (s: string) => s === 'Clarification requested' },
  { id: 'done', label: 'Done', match: (s: string) => ['Approved', 'Rejected', 'Ignored'].includes(s) },
  { id: 'all', label: 'All', match: () => true },
] as const;
const shortCategory: Record<string, string> = {
  'Issuer Availability Update': 'Availability',
  'New Meeting Request': 'New request',
  'Meeting Confirmation': 'Confirmation',
  'Reschedule Request': 'Reschedule',
  'Meeting Cancellation': 'Cancellation',
  'General Conference Inquiry': 'Question',
  'Unrelated Email': 'Unrelated',
};
const operationText: Record<string, string> = {
  add: 'Add',
  replace: 'Replace availability with',
  remove: 'Remove',
  confirm: 'Confirm',
  reschedule: 'Move to',
  cancel: 'Cancel',
  inquiry: 'Answer a question',
};
function proposalLine(e: EmailItem, zone: string) {
  const x = e.proposal?.extraction as
    | { operation: string; windows: { start: string; kind: string }[]; uncertainties: string[] }
    | undefined;
  if (!x) return null;
  const w = x.windows || [];
  const when = w.length === 1 ? fmt(w[0].start, zone, 'EEE h:mm a') : w.length ? `${w.length} time windows` : '';
  const blocked = w.filter((v) => v.kind === 'unavailable');
  const offered = w.filter((v) => v.kind !== 'unavailable');
  const notOk = blocked.length
    ? `Not available ${fmt(blocked[0].start, zone, 'EEE h:mm a')}${blocked.length > 1 ? ` +${blocked.length - 1}` : ''}`
    : '';
  if (blocked.length && (x.operation === 'inquiry' || !offered.length))
    return x.uncertainties?.length ? `${notOk} · 1 thing to check` : notOk;
  if (blocked.length && offered.length) {
    const ok = `${operationText[x.operation] || x.operation} ${offered.length === 1 ? fmt(offered[0].start, zone, 'EEE h:mm a') : `${offered.length} windows`}`;
    return `${notOk} · ${ok}`;
  }
  const verb = operationText[x.operation] || x.operation;
  const base = x.operation === 'inquiry' ? verb : `${verb}${when ? ` ${when}` : ''}`;
  return x.uncertainties?.length ? `${base} · 1 thing to check` : base;
}
function InboxView({
  data,
  conferenceId,
  search,
  onEmail,
  onAdd,
  outlookConnected,
  onSync,
  onConnect,
}: {
  data: AppState;
  conferenceId: string;
  search: string;
  onEmail: (id: string) => void;
  onAdd: () => void;
  outlookConnected: boolean;
  onSync: () => void;
  onConnect: () => void;
}) {
  const [tab, setTab] = useState<(typeof emailTabs)[number]['id']>('review'),
    [category, setCategory] = useState<string | null>(null),
    [issuer, setIssuer] = useState('All issuers');
  const n = names(data);
  const zone = data.conferences.find((c) => c.id === conferenceId)?.timezone || 'America/New_York';
  const base = data.emails.filter(
    (e) =>
      (e.conferenceId === conferenceId || !e.conferenceId) &&
      (issuer === 'All issuers' || e.issuerId === issuer) &&
      `${e.subject} ${e.sender} ${e.body}`.toLowerCase().includes(search.toLowerCase()),
  );
  const inTab = base.filter((e) => emailTabs.find((t) => t.id === tab)!.match(e.status));
  const filtered = inTab
    .filter((e) => !category || e.category === category)
    .sort((x, y) => y.receivedAt.localeCompare(x.receivedAt));
  const categories = Object.keys(shortCategory)
    .map((c) => [c, inTab.filter((e) => e.category === c).length] as const)
    .filter(([, count]) => count > 0);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Email reviews</h1>
          <p>
            {base.filter((e) => e.status === 'Pending review').length} waiting for a decision · open one to see exactly
            what will change
          </p>
        </div>
        <div className="flex gap-2">
          {outlookConnected ? (
            <Button variant="outline" onClick={onSync}>
              <RefreshCw size={15} />
              Sync Outlook
            </Button>
          ) : (
            <Button variant="outline" onClick={onConnect}>
              <Mail size={15} />
              Connect Outlook
            </Button>
          )}
          <Button onClick={onAdd}>
            <Plus size={16} />
            Paste an email
          </Button>
        </div>
      </div>
      <div className="panel">
        <div className="status-tabs" role="tablist" aria-label="Email status">
          {emailTabs.map((t) => {
            const count = base.filter((e) => t.match(e.status)).length;
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={tab === t.id ? 'active' : ''}
                onClick={() => {
                  setTab(t.id);
                  setCategory(null);
                }}
              >
                {t.label}
                <span className={`tab-count ${t.id === 'review' && count ? 'hot' : ''}`}>{count}</span>
              </button>
            );
          })}
        </div>
        <div className="filter-row">
          <button className={`chip ${!category ? 'active' : ''}`} onClick={() => setCategory(null)}>
            All types <small>{inTab.length}</small>
          </button>
          {categories.map(([c, count]) => (
            <button key={c} className={`chip ${category === c ? 'active' : ''}`} onClick={() => setCategory(c)}>
              {shortCategory[c]} <small>{count}</small>
            </button>
          ))}
          <select
            className="compact-select"
            aria-label="Filter by issuer"
            value={issuer}
            onChange={(e) => setIssuer(e.target.value)}
          >
            <option>All issuers</option>
            {data.issuers.map((i) => (
              <option value={i.id} key={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </div>
        {filtered.length ? (
          <div className="inbox-list">
            {filtered.map((e) => {
              const line = e.status === 'Pending review' ? proposalLine(e, zone) : null;
              return (
                <button key={e.id} onClick={() => onEmail(e.id)}>
                  <span className={e.status === 'Pending review' ? 'unread-dot' : 'read-dot'} />
                  <Avatar
                    name={n.issuer(e.issuerId)}
                    color={data.issuers.find((i) => i.id === e.issuerId)?.color}
                  />
                  <div className="inbox-main">
                    <div>
                      <strong>{n.issuer(e.issuerId)}</strong>
                      <span>{fmt(e.receivedAt, undefined, 'MMM d, h:mm a')}</span>
                    </div>
                    <h3>{e.subject}</h3>
                    <p>{e.newContent.replace(/\n/g, ' ').slice(0, 130)}…</p>
                    {line ? (
                      <span className="inbox-proposal">
                        <Sparkles size={12} />
                        <span>{line}</span>
                      </span>
                    ) : (
                      <div className="inbox-tags">
                        <Badge tone="gray">{shortCategory[e.category] || e.category}</Badge>
                        <Badge>{e.status}</Badge>
                      </div>
                    )}
                  </div>
                  <span className="row-cta">
                    {e.status === 'Pending review' ? 'Review' : 'Open'} <ChevronRight size={15} />
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <Empty
            title={tab === 'review' ? 'Inbox zero' : 'Nothing here'}
            description={
              tab === 'review'
                ? 'Every conference email has been handled. New ones land here after each sync.'
                : 'Try another tab or clear the type filter.'
            }
          />
        )}
        <div className="table-footer">
          {outlookConnected ? 'Linked to Outlook' : 'Simulated inbox'}
          <span>Duplicates are skipped by message ID</span>
        </div>
      </div>
    </>
  );
}
function QueueView({
  data,
  conferenceId,
  search,
  onClick,
  run,
  onOpenEmails,
  onOpenDrafts,
  focus,
  setFocus,
}: {
  data: AppState;
  conferenceId: string;
  search: string;
  onClick: (a: AppState['actions'][number]) => void;
  run: Run;
  onOpenEmails: () => void;
  onOpenDrafts: () => void;
  focus: 'all' | KindId;
  setFocus: (f: 'all' | KindId) => void;
}) {
  const [status, setStatus] = useState('Open');
  const [sort, setSort] = useState<SortMode>('soonest');
  const [expanded, setExpanded] = useState<string | null>(null);
  const n = names(data);
  const conference = data.conferences.find((item) => item.id === conferenceId)!;
  const emailCount = data.emails.filter(
    (email) => email.conferenceId === conferenceId && email.status === 'Pending review',
  ).length;
  const draftCount = data.drafts.filter((draft) => draft.status === 'Draft').length;
  const actions = sortActions(
    data.actions.filter(
      (a) =>
        (a.conferenceId === conferenceId || !a.conferenceId) &&
        (status === 'All' || a.status === status) &&
        (focus === 'all' || actionKind(a, data).id === focus) &&
        `${a.title} ${a.recommendation} ${n.issuer(a.issuerId)} ${n.investor(a.investorId)}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    ),
    data,
    sort,
  );
  const openForConference = data.actions.filter(
    (a) => (a.conferenceId === conferenceId || !a.conferenceId) && a.status === 'Open',
  );
  const kindCount = (k: KindId) => openForConference.filter((a) => actionKind(a, data).id === k).length;
  const primaryLabel = (a: AppState['actions'][number]) => {
    if (a.type === 'Resource allocation') return 'Review allocation';
    if (a.requestId || /request|alternative/i.test(a.type)) return 'Review request';
    if (a.emailId) return 'Review update';
    return 'Review';
  };
  return (
    <>
      <div className="page-heading action-queue-heading">
        <div>
          <h1>
            Action queue <span className="queue-heading-count">{openForConference.length}</span>
          </h1>
        </div>
        <div className="queue-secondary-links">
          <button onClick={onOpenEmails}>
            <Mail size={15} /> Email reviews <span>{emailCount}</span>
          </button>
          <button onClick={onOpenDrafts}>
            <FileSpreadsheet size={15} /> Drafts <span>{draftCount}</span>
          </button>
        </div>
      </div>
      <div className="decision-summary">
        <div>
          <strong>{kindCount('new')}</strong>
          <span>New requests</span>
        </div>
        <div>
          <strong>{kindCount('reschedule')}</strong>
          <span>Reschedules</span>
        </div>
        <div>
          <strong>{kindCount('availability') + kindCount('cancel')}</strong>
          <span>Availability & cancellations</span>
        </div>
        <p><ShieldCheck size={14} /> No schedule changes without your approval</p>
      </div>
      <div className="panel decision-panel">
        <div className="decision-toolbar">
          <div className="decision-filters" aria-label="Filter action queue">
            {(['all', ...kindOrder] as const).map((id) => {
              const count = id === 'all' ? openForConference.length : kindCount(id);
              if (id === 'other' && !count) return null;
              return (
                <button key={id} className={focus === id ? 'active' : ''} onClick={() => setFocus(id)}>
                  {id === 'all' ? 'All' : kindLabel[id]} <span>{count}</span>
                </button>
              );
            })}
          </div>
          <div className="decision-toolbar-right">
            <SortToggle value={sort} onChange={setSort} />
            <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
              {['Open', 'Resolved', 'Rejected', 'All'].map((s) => <option key={s}>{s}</option>)}
            </select>
          </div>
        </div>
        <div className="decision-list">
          {actions.map((a) => {
            const issuer = n.issuer(a.issuerId);
            const investor = n.investor(a.investorId);
            const kind = actionKind(a, data);
            const when = actionWhen(a, data);
            const email = data.emails.find((x) => x.id === a.emailId);
            const summary = (email && proposalLine(email, conference.timezone)) || a.recommendation;
            return (
              <div className={`decision-row kind-${kind.id}`} key={a.id}>
                <span className="decision-priority-mark" />
                <div className="decision-main">
                  <div className="decision-kicker">
                    <span className={`kind-tag kind-${kind.id}`}>{kind.label}</span>
                  </div>
                  <h3>
                    {issuer === 'Unassociated' ? a.title : issuer}
                    {issuer !== 'Unassociated' && investor !== '—' && <><i>with</i>{investor}</>}
                  </h3>
                  <p>{summary}</p>
                  <div className="decision-meta">
                    {when && <span><Clock3 size={12} /> {fmt(when, conference.timezone, 'EEE, h:mm a')}</span>}
                    <span>{n.user(a.assignedTo)}</span>
                    <span>Received {fmt(actionReceived(a, data), conference.timezone, 'MMM d, h:mm a')}</span>
                  </div>
                </div>
                <div className="decision-primary-action">
                  <Button size="sm" onClick={() => onClick(a)}>
                    {primaryLabel(a)} <ArrowRight size={13} />
                  </Button>
                  <button
                    className="decision-more"
                    aria-label={`More options for ${a.title}`}
                    aria-expanded={expanded === a.id}
                    onClick={() => setExpanded(expanded === a.id ? null : a.id)}
                  >
                    <MoreHorizontal size={17} />
                  </button>
                </div>
                {expanded === a.id && (
                  <div className="decision-details">
                    <span>Owner</span>
                    <select
                      aria-label={`Assign ${a.title}`}
                      value={a.assignedTo || ''}
                      onChange={(e) => run('action', { id: a.id, assignedTo: e.target.value || null }, 'Coverage assignment updated')}
                    >
                      <option value="">Unassigned</option>
                      {data.users.filter((u) => u.role === 'BANKER').map((u) => (
                        <option key={u.id} value={u.id}>{u.name}</option>
                      ))}
                    </select>
                    <div />
                    {a.status === 'Open' && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => run('action', { id: a.id, status: 'Rejected' }, 'Action rejected')}>Reject</Button>
                        <Button size="sm" variant="outline" onClick={() => run('action', { id: a.id, status: 'Resolved' }, 'Action resolved. No schedule change applied.')}>Mark resolved</Button>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {!actions.length && (
          <Empty
            title="Nothing waiting on you"
            description="New proposals and investor requests will appear here automatically."
          />
        )}
      </div>
    </>
  );
}
