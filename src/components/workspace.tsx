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
  LogOut,
  Loader2,
  Mail,
  Settings,
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
import { DraftEditor, EmailReview, type Compose } from './review';
import { Sheet } from './ui/sheet';
import { RequestDecision } from './decision';
import { AvailabilityView, PlannerView, RequestDetail, RequestsView } from './views';
import { ResourceAllocationView } from './resources';
import { AuditTrail } from './audit';
import { SalesEmailsView } from './sales';
import { MeetingDrawer, MeetingForm } from './meeting';
import { actionKind, askOf, askPosition, kindLabel, kindOrder, openWork, type KindId } from './queue-model';
import { windowLabel } from '@/lib/review-rules';
const menu = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'queue', label: 'Action queue', icon: CheckCheck },
  { id: 'requests', label: 'Meeting requests', icon: Users },
  { id: 'emails', label: 'My emails', icon: Mail },
  { id: 'schedule', label: 'Schedule', icon: CalendarDays },
  { id: 'allocation', label: 'Allocation', icon: SlidersHorizontal },
];

type Action = AppState['actions'][number];
/** The meeting time an action is about: the request's slot or the earliest window in the email proposal. */
function actionWhen(a: Action, data: AppState): string | null {
  const r = data.requests.find((x) => x.id === a.requestId);
  if (r) return r.start;
  const x = askOf(a, data).extraction;
  if (x?.referenceTime) return x.referenceTime;
  const w = x?.windows || [];
  return w.length ? [...w].sort((p, q) => p.start.localeCompare(q.start))[0].start : null;
}
/** Readable time for the queue: the meeting the ask is about, or the window it adds/blocks. */
function whenLabel(a: Action, data: AppState, zone: string) {
  const x = askOf(a, data).extraction;
  if (!x) return null;
  if (x.referenceTime) return fmt(x.referenceTime, zone, 'EEE, h:mm a');
  const w = [...(x.windows || [])].sort((p, q) => p.start.localeCompare(q.start))[0];
  return w ? windowLabel(w, zone, false) : null;
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
    [review, setReview] = useState<{ emailId: string; proposalId?: string | null } | null>(null),
    [needsLogin, setNeedsLogin] = useState<{ id: string; name: string; role: string }[] | null>(null),
    [bellOpen, setBellOpen] = useState(false),
    [meetingId, setMeetingId] = useState<string | null>(null),
    [newMeeting, setNewMeeting] = useState(false),
    [composer, setComposer] = useState<Compose | null>(null),
    [draftId, setDraftId] = useState<string | null>(null),
    [queueSection, setQueueSection] = useState<'tasks' | 'emails' | 'drafts'>('tasks'),
    [scheduleSection, setScheduleSection] = useState<'schedule' | 'availability'>('schedule'),
    [queueFocus, setQueueFocus] = useState<'all' | 'triage' | KindId>('all'),
    [overviewSort, setOverviewSort] = useState<SortMode>('soonest'),
    [help, setHelp] = useState(false),
    [busy, setBusy] = useState(false),
    [sheetRequestId, setSheetRequestId] = useState<string | null>(null),
    [mobile, setMobile] = useState(false);
  const reload = useCallback(async () => {
    const response = await fetch('/api/state', { cache: 'no-store' });
    const result = await response.json();
    if (response.status === 401) {
      // Signed out (or the session was revoked): show the profile picker instead of failing.
      const s = await (await fetch('/api/session', { cache: 'no-store' })).json();
      setData(null);
      setNeedsLogin(s.profiles || []);
      return;
    }
    if (!response.ok) throw new Error(result.error);
    setNeedsLogin(null);
    setData(result);
  }, []);
  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        // No silent auto-login: without a session the person picks a profile explicitly.
        const s = await (await fetch('/api/session', { cache: 'no-store' })).json();
        if (!s.user) {
          if (!cancelled) setNeedsLogin(s.profiles || []);
          return;
        }
        if (!cancelled) await reload();
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Unable to load workspace');
      }
    }
    void init();
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void reload().catch(() => {});
    }, 10000);
    // Coming back to the tab shows the latest state at once (no manual reload).
    const onFocus = () => void reload().catch(() => {});
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
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
    navigate('settings');
    history.replaceState(null, '', location.pathname);
  }, []);
  // Deep link: ?email=<id> opens that email's review.
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('email');
    if (id) setReview({ emailId: id });
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
      setReview(null);
      setDraftId(null);
      setPage('overview');
      await reload();
    } catch (e) {
      setToast({ message: String(e), error: true });
    }
  }
  /** "Reply": reopen the email's draft if there is one, else compose without saving anything. */
  async function openReply(emailId: string) {
    const r = await fetch('/api/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'replyPreview', data: { emailId } }),
    });
    const out = await r.json();
    if (!r.ok) return setToast({ message: out.error, error: true });
    setReview(null);
    if (out.result.existingDraftId) setDraftId(out.result.existingDraftId);
    else setComposer({ emailId, ...out.result });
  }
  async function signOut() {
    await fetch('/api/session', { method: 'DELETE' });
    setReview(null);
    setDraftId(null);
    setPage('overview');
    await reload();
  }
  if (needsLogin)
    return (
      <LoginScreen
        profiles={needsLogin}
        onPick={async (id) => {
          const r = await fetch('/api/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: id }),
          });
          if (!r.ok) {
            setError((await r.json()).error || 'Sign-in failed');
            return;
          }
          setNeedsLogin(null);
          await reload();
        }}
        error={error}
      />
    );
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
    work = openWork(data, conferenceId),
    openActions = [...work.triage, ...work.conference],
    reviewEmail = data.emails.find((e) => e.id === review?.emailId),
    drawerMeeting = data.meetings.find((m) => m.id === meetingId),
    sheetRequest = data.requests.find((r) => r.id === sheetRequestId),
    outlook = data.outlook,
    draft = data.drafts.find((d) => d.id === draftId);
  const confirmed = data.meetings.filter((m) => m.conferenceId === conferenceId && m.status === 'Confirmed');
  function actionClick(a: AppState['actions'][number]) {
    if (a.emailId) setReview({ emailId: a.emailId, proposalId: a.proposalId });
    else if (a.requestId) setSheetRequestId(a.requestId);
    else if (a.meetingId && data!.meetings.some((m) => m.id === a.meetingId)) setMeetingId(a.meetingId);
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
            .filter((m) => (banker ? m.id !== 'emails' : !['queue', 'allocation'].includes(m.id)))
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
          {banker && (
            <button
              className={`nav-item ${page === 'settings' ? 'active' : ''}`}
              onClick={() => navigate('settings')}
            >
              <Settings size={18} strokeWidth={1.7} />
              <span>Settings</span>
              <span className={`ol-dot ${outlook?.connected ? 'on' : ''}`} title={outlook?.connected ? 'Outlook connected' : 'Outlook not connected'} />
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
            <button className="signout" onClick={signOut} title="Sign out" aria-label="Sign out">
              <LogOut size={15} />
            </button>
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
                  : menu.find((m) => m.id === page)?.label || { audit: 'Audit trail', settings: 'Settings', emails: 'My emails' }[page]}
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
            {data.demo && (
              <span className="demo-pill" title="Demo mode: profiles sign in without a password and all data is synthetic.">
                Demo mode
              </span>
            )}
            <div className="bell-wrap">
              <button
                className="notification"
                aria-label="Notifications"
                aria-expanded={bellOpen}
                onClick={() => {
                  setBellOpen(!bellOpen);
                  // Opening the bell marks your notices as read.
                  if (!bellOpen && data.notifications.some((x) => !x.readAt))
                    void fetch('/api/commands', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ type: 'notificationsRead', data: {} }),
                    }).then(() => setTimeout(() => void reload(), 4000));
                }}
              >
                <Bell size={18} />
                {data.notifications.some((x) => !x.readAt) && (
                  <b className="bell-count">{data.notifications.filter((x) => !x.readAt).length}</b>
                )}
              </button>
              {bellOpen && (
                <RecentChanges
                  data={data}
                  onClose={() => setBellOpen(false)}
                  onOpenAudit={() => {
                    setBellOpen(false);
                    navigate('audit');
                  }}
                  onOpenMeeting={(id) => {
                    setBellOpen(false);
                    setMeetingId(id);
                  }}
                  onOpenNotice={(x) => {
                    setBellOpen(false);
                    if (x.meetingId && data.meetings.some((m) => m.id === x.meetingId)) setMeetingId(x.meetingId);
                    else if (x.requestId && data.requests.some((r) => r.id === x.requestId)) setSheetRequestId(x.requestId);
                    else if (x.emailId) banker ? setReview({ emailId: x.emailId }) : navigate('emails');
                  }}
                />
              )}
            </div>
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
              onEmail={(id) => setReview({ emailId: id })}
              onAdd={() => setEmailOpen(true)}
              outlookConnected={Boolean(outlook?.connected)}
              onSync={syncOutlook}
              onConnect={() => navigate('settings')}
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
          {page === 'emails' && !banker && <SalesEmailsView data={data} search={search} />}
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
              onEmail={(id) => setReview({ emailId: id })}
            />
          )}
          {page === 'schedule' && scheduleSection === 'schedule' && (
            <PlannerView
              key={conferenceId}
              data={data}
              conferenceId={conferenceId}
              search={search}
              onOpenMeeting={setMeetingId}
              onNewMeeting={banker ? () => setNewMeeting(true) : undefined}
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
          {page === 'settings' && banker && (
            <>
              <div className="page-heading">
                <div>
                  <h1>Settings</h1>
                  <p>Email connection for your workspace.</p>
                </div>
              </div>
              <div className="panel settings-panel">
                <h3>Outlook</h3>
                <p className="muted">
                  Corda reads conference emails from your inbox and sends approved drafts from your address.
                </p>
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
              </div>
            </>
          )}
          {page === 'audit' && (
            <AuditTrail
              data={data}
              timezone={c.timezone}
              onOpenEmail={(id) => setReview({ emailId: id })}
              onOpenMeeting={setMeetingId}
            />
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
          proposalId={review?.proposalId}
          data={data}
          close={() => setReview(null)}
          run={run}
          onReply={openReply}
          onOpenEmail={(id) => setReview({ emailId: id })}
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
      {drawerMeeting && (
        <MeetingDrawer key={drawerMeeting.id} meeting={drawerMeeting} data={data} run={run} close={() => setMeetingId(null)} />
      )}
      {newMeeting && (
        <Sheet open onOpenChange={(v) => !v && setNewMeeting(false)} title="New meeting" description={`${c.name} · checked against availability, meetings, bankers and rooms`}>
          <MeetingForm
            data={data}
            run={run}
            conferenceId={conferenceId}
            onCancel={() => setNewMeeting(false)}
            onSaved={() => setNewMeeting(false)}
          />
        </Sheet>
      )}
      {composer && <DraftEditor key={composer.emailId} compose={composer} data={data} close={() => setComposer(null)} run={run} />}
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
              Use the profile selector in the sidebar to switch between the{' '}
              {data.users.filter((u) => u.role === 'BANKER').length} demo bankers and{' '}
              {data.users.filter((u) => u.role === 'SALES').length} salespeople. Sales can access only their own
              requests and authorized meetings. Sign out to pick another profile.
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
          const when = actionWhen(a, data);
          const issuer = n.issuer(a.issuerId);
          const investor = n.investor(a.investorId);
          const what = askLine(a, data, zone) || (when ? fmt(when, zone, 'EEE, MMM d · h:mm a') : null);
          const pos = askPosition(a, data);
          return (
            <button className={`decide-card kind-${kind.id}`} key={a.id} onClick={() => onClick(a)}>
              <span className={`kind-tag kind-${kind.id}`}>{kind.label}</span>
              <strong>{issuer === 'Unassociated' ? 'Needs triage' : issuer}</strong>
              {issuer !== 'Unassociated' && investor !== '—' && <span className="decide-with">with {investor}</span>}
              <span className="decide-what">{what || a.recommendation}</span>
              <span className="decide-foot">
                <span>{pos || fmt(actionReceived(a, data), zone, 'MMM d, h:mm a')}</span>
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
  {
    id: 'done',
    label: 'Done',
    match: (s: string) => ['Approved', 'Rejected', 'Resolved', 'Acknowledged', 'Quarantined'].includes(s),
  },
  { id: 'ignored', label: 'Ignored', match: (s: string) => s === 'Ignored' },
  { id: 'all', label: 'All', match: () => true },
] as const;
const shortCategory: Record<string, string> = {
  'Escalation / complaint': 'Escalation',
  'Multiple asks': 'Several asks',
  'Issuer Availability Update': 'Availability',
  'New Meeting Request': 'New request',
  'Meeting Confirmation': 'Confirmation',
  'Reschedule Request': 'Reschedule',
  'Meeting Cancellation': 'Cancellation',
  'General Conference Inquiry': 'Question',
  'Unrelated Email': 'Unrelated',
};
/** One line about the ask behind an action (its stored summary, plus a hint when something is open). */
function askLine(a: Action, data: AppState, zone: string) {
  const { proposal, extraction } = askOf(a, data);
  if (!proposal || !extraction) return null;
  const open = extraction.uncertainties.filter((u) => !u.startsWith('Select and verify')).length;
  const summary = proposal.summary || summaryFallback(extraction, zone);
  return open && extraction.category !== 'Escalation / complaint' ? `${summary} · ${open} thing${open === 1 ? '' : 's'} to check` : summary;
}
function summaryFallback(x: { windows: { start: string; end: string; kind: string }[] }, zone: string) {
  return x.windows.length ? x.windows.map((w) => windowLabel(w, zone)).join(', ') : '';
}
function emailLine(e: EmailItem) {
  const open = e.proposals.filter((p) => ['Pending', 'Clarification requested'].includes(p.status));
  if (!e.proposals.length) return null;
  if (e.proposals.length === 1) return e.proposals[0].summary;
  return `${e.proposals.length} asks${open.length < e.proposals.length ? ` (${open.length} open)` : ''} · ${e.proposals.map((p) => p.summary).join(' · ')}`;
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
  const [tab, setTab] = useState<(typeof emailTabs)[number]['id'] | 'triage'>('review'),
    [category, setCategory] = useState<string | null>(null),
    [issuer, setIssuer] = useState('All issuers');
  const n = names(data);
  const matches = (e: EmailItem) =>
    (issuer === 'All issuers' || e.issuerId === issuer) &&
    `${e.subject} ${e.sender} ${e.body}`.toLowerCase().includes(search.toLowerCase());
  // Emails tied to no event live only in "Needs triage", not in every conference's lists.
  // Ignored mail has no event; it is listed under "Ignored" in every conference so nothing is hidden.
  const base = data.emails.filter(
    (e) => (e.conferenceId === conferenceId || (e.status === 'Ignored' && !e.conferenceId)) && matches(e),
  );
  const triage = data.emails.filter(
    (e) => !e.conferenceId && !['Ignored', 'Quarantined'].includes(e.status) && matches(e),
  );
  const inTab = tab === 'triage' ? triage : base.filter((e) => emailTabs.find((t) => t.id === tab)!.match(e.status));
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
            {base.filter((e) => e.status === 'Pending review').length} waiting for a decision
            {triage.length ? ` · ${triage.length} need an event` : ''} · open one to see exactly what will change
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
          <button
            role="tab"
            aria-selected={tab === 'triage'}
            className={`${tab === 'triage' ? 'active' : ''} triage-tab`}
            onClick={() => {
              setTab('triage');
              setCategory(null);
            }}
          >
            Needs triage
            <span className={`tab-count ${triage.length ? 'hot' : ''}`}>{triage.length}</span>
          </button>
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
              const line = ['Pending review', 'Clarification requested'].includes(e.status) ? emailLine(e) : null;
              return (
                <button key={e.id} onClick={() => onEmail(e.id)}>
                  <span className={e.status === 'Pending review' ? 'unread-dot' : 'read-dot'} />
                  <Avatar
                    name={n.issuer(e.issuerId)}
                    color={data.issuers.find((i) => i.id === e.issuerId)?.color}
                  />
                  <div className="inbox-main">
                    <div>
                      <strong>
                        {n.issuer(e.issuerId) === 'Unassociated' ? e.originalSenderName || e.sender : n.issuer(e.issuerId)}
                      </strong>
                      {e.senderStatus === 'unverified' && <span className="mini-flag red">Sender not verified</span>}
                      {e.status === 'Quarantined' && <span className="mini-flag red">Quarantined</span>}
                      {e.forwardedBy && <span className="mini-flag gray">Forwarded</span>}
                      {e.category === 'Escalation / complaint' && <span className="mini-flag amber">Escalation</span>}
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
            title={tab === 'review' ? 'Inbox zero' : tab === 'triage' ? 'Nothing to triage' : 'Nothing here'}
            description={
              tab === 'review'
                ? 'Every conference email has been handled. New ones land here after each sync.'
                : tab === 'triage'
                  ? 'Emails that name no event and could not be placed land here.'
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
  focus: 'all' | 'triage' | KindId;
  setFocus: (f: 'all' | 'triage' | KindId) => void;
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
  const work = openWork(data, conferenceId);
  const text = (a: Action) =>
    `${a.title} ${a.recommendation} ${n.issuer(a.issuerId)} ${n.investor(a.investorId)}`.toLowerCase().includes(search.toLowerCase());
  const pool = data.actions.filter(
    (a) =>
      (status === 'All' ||
        a.status === status ||
        (status === 'Open' && a.status === 'Acknowledged' && a.assignedTo === data.user.id)) &&
      text(a),
  );
  const triage = sortActions(pool.filter((a) => !a.conferenceId), data, sort);
  const actions = sortActions(
    pool.filter((a) => a.conferenceId === conferenceId && (focus === 'all' || actionKind(a, data).id === focus)),
    data,
    sort,
  ).sort((x, y) => Number(y.status === 'Acknowledged') - Number(x.status === 'Acknowledged'));
  const kindCount = (k: KindId) => work.conference.filter((a) => actionKind(a, data).id === k).length;
  const primaryLabel = (a: AppState['actions'][number]) => {
    if (/escalation/i.test(a.type)) return 'Handle escalation';
    if (a.type === 'Resource allocation') return 'Review allocation';
    if (a.type === 'Availability conflict') return 'Open meeting';
    if (a.requestId || /request|alternative/i.test(a.type)) return 'Review request';
    if (a.emailId) return 'Review update';
    return 'Review';
  };
  const row = (a: Action) => {
    const issuer = n.issuer(a.issuerId);
    const investor = n.investor(a.investorId);
    const kind = actionKind(a, data);
    const when = actionWhen(a, data);
    const summary = askLine(a, data, conference.timezone) || a.recommendation;
    const pos = askPosition(a, data);
    const email = askOf(a, data).email;
    return (
      <div className={`decision-row kind-${kind.id}`} key={a.id}>
        <span className="decision-priority-mark" />
        <div className="decision-main">
          <div className="decision-kicker">
            <span className={`kind-tag kind-${kind.id}`}>{kind.label}</span>
            {pos && <span className="ask-pos">{pos}</span>}
            {a.status === 'Acknowledged' && <span className="mini-flag amber">Acknowledged · yours</span>}
            {a.priority === 'Urgent' && a.status !== 'Acknowledged' && <span className="mini-flag red">Urgent</span>}
            {email?.senderStatus === 'unverified' && <span className="mini-flag red">Sender not verified</span>}
          </div>
          <h3>
            {issuer === 'Unassociated' ? email?.subject || a.title : issuer}
            {issuer !== 'Unassociated' && investor !== '—' && <><i>with</i>{investor}</>}
          </h3>
          <p>{summary}</p>
          <div className="decision-meta">
            {when && <span><Clock3 size={12} /> {whenLabel(a, data, conference.timezone) || fmt(when, conference.timezone, 'EEE, h:mm a')}</span>}
            <span>
              {n.user(a.assignedTo)}
              {a.ccUserIds?.length ? ` · cc ${a.ccUserIds.map(n.user).join(', ')}` : ''}
            </span>
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
            {a.status === 'Open' && !a.emailId && (
              <>
                <Button size="sm" variant="ghost" onClick={() => run('action', { id: a.id, status: 'Rejected' }, 'Action rejected')}>Reject</Button>
                <Button size="sm" variant="outline" onClick={() => run('action', { id: a.id, status: 'Resolved' }, 'Action resolved. No schedule change applied.')}>Mark resolved</Button>
              </>
            )}
          </div>
        )}
      </div>
    );
  };
  const showTriage = (focus === 'all' || focus === 'triage') && triage.length > 0;
  return (
    <>
      <div className="page-heading action-queue-heading">
        <div>
          <h1>
            Action queue <span className="queue-heading-count">{work.total}</span>
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
          <strong>{kindCount('escalation')}</strong>
          <span>Escalations</span>
        </div>
        <div>
          <strong>{kindCount('new')}</strong>
          <span>New requests</span>
        </div>
        <div>
          <strong>{kindCount('reschedule') + kindCount('cancel')}</strong>
          <span>Moves & cancellations</span>
        </div>
        <div>
          <strong>{work.triage.length}</strong>
          <span>Needs triage</span>
        </div>
        <p><ShieldCheck size={14} /> No schedule changes without your approval</p>
      </div>
      <div className="panel decision-panel">
        <div className="decision-toolbar">
          <div className="decision-filters" aria-label="Filter action queue">
            {(['all', ...kindOrder, 'triage'] as const).map((id) => {
              const count = id === 'all' ? work.total : id === 'triage' ? work.triage.length : kindCount(id);
              if ((id === 'other' || id === 'escalation' || id === 'triage') && !count) return null;
              return (
                <button key={id} className={`${focus === id ? 'active' : ''} ${id === 'triage' ? 'triage' : ''}`} onClick={() => setFocus(id)}>
                  {id === 'all' ? 'All' : id === 'triage' ? 'Needs triage' : kindLabel[id]} <span>{count}</span>
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
        {showTriage && (
          <div className="triage-lane">
            <div className="triage-head">
              <strong>Needs triage</strong>
              <span>No event could be determined — pick one in the review. Shown here once, not in every conference.</span>
            </div>
            <div className="decision-list">{triage.map(row)}</div>
          </div>
        )}
        {focus !== 'triage' && <div className="decision-list">{actions.map(row)}</div>}
        {!actions.length && !showTriage && (
          <Empty
            title="Nothing waiting on you"
            description="New proposals and investor requests will appear here automatically."
          />
        )}
      </div>
    </>
  );
}

function LoginScreen({
  profiles,
  onPick,
  error,
}: {
  profiles: { id: string; name: string; role: string }[];
  onPick: (id: string) => void;
  error: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const groups = [
    ['BANKER', 'Bankers'],
    ['SALES', 'Sales'],
  ] as const;
  return (
    <main className="loading-screen login-screen">
      <CordaMark />
      <h1>Corda AI</h1>
      {profiles.length ? (
        <>
          <span className="demo-pill">Demo mode</span>
          <p>
            These are demo profiles: anyone can pick one without a password. All organizations, people and emails are
            synthetic. Production deployments disable this picker and require sign-in.
          </p>
          <div className="profile-picker">
            {groups.map(([role, label]) => (
              <section key={role}>
                <h2>{label}</h2>
                <div>
                  {profiles
                    .filter((p) => p.role === role)
                    .map((p) => (
                      <button
                        key={p.id}
                        disabled={Boolean(busy)}
                        onClick={async () => {
                          setBusy(p.id);
                          await onPick(p.id);
                          setBusy(null);
                        }}
                      >
                        <Avatar name={p.name} color="#436b5e" />
                        <span>
                          <strong>{p.name}</strong>
                          <small>{role === 'BANKER' ? 'Investment Banking' : 'Institutional Sales'}</small>
                        </span>
                        {busy === p.id ? <Loader2 size={15} className="spin" /> : <ChevronRight size={15} />}
                      </button>
                    ))}
                </div>
              </section>
            ))}
          </div>
        </>
      ) : (
        <p>Sign-in is required. Demo profiles are disabled on this server.</p>
      )}
      {error && <p className="error">{error}</p>}
    </main>
  );
}

/** Human label for an audited record (never a raw id). */
function entityLabel(a: AppState['auditLogs'][number], data: AppState) {
  const n = names(data);
  const zone = data.conferences[0]?.timezone;
  const meeting = (id: string) => {
    const m = data.meetings.find((x) => x.id === id);
    return m ? `${n.issuer(m.issuerId)} × ${n.investor(m.investorId)} · ${fmt(m.start, zone, 'EEE h:mm a')}` : 'Meeting';
  };
  switch (a.entityType) {
    case 'Meeting':
      return meeting(a.entityId);
    case 'Email':
      return data.emails.find((e) => e.id === a.entityId)?.subject || 'Email';
    case 'Proposal': {
      const e = data.emails.find((x) => x.proposals.some((p) => p.id === a.entityId));
      const p = e?.proposals.find((x) => x.id === a.entityId);
      return p ? `${p.summary || e!.subject}${e!.proposals.length > 1 ? ` (ask ${p.askIndex + 1} of ${e!.proposals.length})` : ''}` : 'Email ask';
    }
    case 'MeetingRequest': {
      const r = data.requests.find((x) => x.id === a.entityId);
      return r ? `${n.investor(r.investorId)} → ${n.issuer(r.issuerId)} request` : 'Meeting request';
    }
    case 'Availability':
      return data.issuers.some((i) => i.id === a.entityId) ? `${n.issuer(a.entityId)} availability` : 'Availability window';
    case 'Draft': {
      const d = data.drafts.find((x) => x.id === a.entityId);
      return d ? d.subject : 'Draft';
    }
    case 'Action':
      return data.actions.find((x) => x.id === a.entityId)?.title || 'Queue item';
    case 'Conference':
      return n.conference(a.entityId);
    case 'AllocationRun':
      return 'Allocation run';
    case 'AllocationProposal':
      return 'Allocation proposal';
    default:
      return a.entityType;
  }
}
function RecentChanges({
  data,
  onClose,
  onOpenAudit,
  onOpenMeeting,
  onOpenNotice,
}: {
  data: AppState;
  onClose: () => void;
  onOpenAudit: () => void;
  onOpenMeeting: (id: string) => void;
  onOpenNotice: (x: AppState['notifications'][number]) => void;
}) {
  const n = names(data);
  const [tab, setTab] = useState<'mine' | 'all'>(data.notifications.length ? 'mine' : 'all');
  const items = data.auditLogs.slice(0, 10);
  return (
    <div className="bell-pop" role="dialog" aria-label="Notifications">
      <div className="bell-head">
        <div className="bell-tabs">
          <button className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')}>
            For you {data.notifications.filter((x) => !x.readAt).length ? `(${data.notifications.filter((x) => !x.readAt).length})` : ''}
          </button>
          {data.user.role === 'BANKER' && (
            <button className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>
              All changes
            </button>
          )}
        </div>
        <button aria-label="Close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      {tab === 'mine' ? (
        data.notifications.length ? (
          data.notifications.slice(0, 15).map((x) => (
            <button
              key={x.id}
              className={`bell-item ${x.readAt ? '' : 'unread'}`}
              onClick={() => onOpenNotice(x)}
            >
              <span>{x.text}</span>
              <small>{fmt(x.createdAt, undefined, 'MMM d, h:mm a')}</small>
            </button>
          ))
        ) : (
          <p className="muted">Nothing new for you. Changes others make to your meetings and clients show here.</p>
        )
      ) : items.length ? (
        items.map((a) => (
          <div key={a.id} className="bell-item">
            <strong>{a.action}</strong>
            <span>{entityLabel(a, data)}</span>
            <small>
              {n.user(a.actorId)} · {fmt(a.createdAt, undefined, 'MMM d, h:mm a')}
            </small>
          </div>
        ))
      ) : (
        <p className="muted">No changes yet.</p>
      )}
      {data.user.role === 'BANKER' && (
        <button className="text-button" onClick={onOpenAudit}>
          Open audit trail <ArrowUpRight size={13} />
        </button>
      )}
    </div>
  );
}
