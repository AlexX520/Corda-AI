'use client';
import { useCallback, useEffect, useState } from 'react';
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
import { AvailabilityView, PlannerView, RequestsView } from './views';
import { ResourceAllocationView } from './resources';
const menu = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'queue', label: 'Action queue', icon: CheckCheck },
  { id: 'availability', label: 'Issuer availability', icon: Clock3 },
  { id: 'requests', label: 'Meeting requests', icon: Users },
  { id: 'schedule', label: 'Schedule & allocation', icon: CalendarDays },
];
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
    [scheduleSection, setScheduleSection] = useState<'schedule' | 'allocation'>('schedule'),
    [help, setHelp] = useState(false),
    [busy, setBusy] = useState(false),
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
    } else if (id === 'resources') {
      setPage('schedule');
      setScheduleSection('allocation');
    } else {
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
    draft = data.drafts.find((d) => d.id === draftId);
  function actionClick(a: AppState['actions'][number]) {
    if (a.emailId) setReviewId(a.emailId);
    else if (a.requestId) navigate('requests');
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
            .filter((m) => banker || m.id !== 'queue')
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
          {page === 'schedule' && banker && (
            <div className="workspace-subnav" aria-label="Schedule and allocation sections">
              <button className={scheduleSection === 'schedule' ? 'active' : ''} onClick={() => setScheduleSection('schedule')}>Schedules</button>
              <button className={scheduleSection === 'allocation' ? 'active' : ''} onClick={() => setScheduleSection('allocation')}>Coverage & resources</button>
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
                  icon={CalendarDays}
                  label="Confirmed meetings"
                  value={
                    data.meetings.filter(
                      (m) => m.conferenceId === conferenceId && m.status === 'Confirmed',
                    ).length
                  }
                  foot="Approved and on the planner"
                  tone="green"
                />
                <Stat
                  icon={Users}
                  label="Meeting requests"
                  value={
                    data.requests.filter(
                      (r) =>
                        r.conferenceId === conferenceId &&
                        !['Confirmed', 'Cancelled'].includes(r.status),
                    ).length
                  }
                  foot="Investor conversations in motion"
                  tone="blue"
                />
                <Stat
                  icon={banker ? Sparkles : CheckCheck}
                  label={banker ? 'Needs your review' : 'Potential matches'}
                  value={
                    banker
                      ? openActions.length
                      : data.requests.filter(
                          (r) => r.conferenceId === conferenceId && r.status === 'Potential Match',
                        ).length
                  }
                  foot={banker ? 'AI has done the groundwork' : 'Subject to banker approval'}
                  tone="amber"
                />
              </div>
              <div className="overview-columns">
                <div className="panel">
                  <div className="panel-heading">
                    <div>
                      <h3>
                        {banker ? 'Your action queue' : 'Your recent requests'}{' '}
                        <span className="count-pill">
                          {banker
                            ? openActions.length
                            : data.requests.filter((r) => r.conferenceId === conferenceId).length}
                        </span>
                      </h3>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => navigate(banker ? 'queue' : 'requests')}
                    >
                      View all <ArrowUpRight size={14} />
                    </button>
                  </div>
                  {banker ? (
                    <ActionList
                      actions={openActions
                        .filter((a) =>
                          `${a.title} ${a.type}`.toLowerCase().includes(search.toLowerCase()),
                        )
                        .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))
                        .slice(0, 4)}
                      data={data}
                      onClick={actionClick}
                    />
                  ) : (
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
                  )}
                </div>
                <div className="panel schedule-preview">
                  <div className="panel-heading">
                    <div>
                      <h3>On the agenda</h3>
                      <p>{fmt(`${c.startDate}T12:00:00Z`, c.timezone, 'EEEE, MMMM d')}</p>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => navigate('planner')}
                      aria-label="Open conference planner"
                    >
                      <ArrowUpRight size={17} />
                    </button>
                  </div>
                  <div className="agenda">
                    {data.meetings
                      .filter(
                        (m) =>
                          m.conferenceId === conferenceId &&
                          m.status === 'Confirmed' &&
                          fmt(m.start, c.timezone, 'yyyy-MM-dd') === c.startDate,
                      )
                      .slice(0, 4)
                      .map((m) => (
                        <button
                          key={m.id}
                          onClick={() => navigate('planner')}
                          className="agenda-item"
                        >
                          <span className="agenda-time">
                            {fmt(m.start, c.timezone, 'h:mm')}
                            <small>{fmt(m.start, c.timezone, 'a')}</small>
                          </span>
                          <div
                            className="agenda-detail"
                            style={{
                              borderLeftColor: data.issuers.find((i) => i.id === m.issuerId)?.color,
                            }}
                          >
                            <strong>
                              {n.issuer(m.issuerId)} <span>×</span> {n.investor(m.investorId)}
                            </strong>
                            <p>
                              <MapPin size={11} />
                              {m.location || 'Location to be confirmed'}
                            </p>
                            <Badge tone="green">Confirmed</Badge>
                          </div>
                        </button>
                      ))}
                    {!data.meetings.some((m) => m.conferenceId === conferenceId) && (
                      <Empty
                        title="A clear calendar"
                        description="Confirmed meetings will appear here."
                      />
                    )}
                  </div>
                  <button className="full-width-link" onClick={() => navigate('planner')}>
                    Open conference planner <ArrowRight size={14} />
                  </button>
                </div>
              </div>
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
            />
          )}
          {page === 'requests' && (
            <RequestsView
              data={data}
              conferenceId={conferenceId}
              search={search}
              run={run}
              onNew={() => setRequestOpen(true)}
            />
          )}
          {page === 'availability' && (
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
          {page === 'schedule' && scheduleSection === 'allocation' && banker && (
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
                <Badge tone="amber">Simulated sending only</Badge>
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
        />
      )}
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
            <strong>Delivery:</strong> All sends are simulated and audited. Outlook Graph is a
            future integration interface.
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
}: {
  icon: typeof CalendarDays;
  label: string;
  value: number;
  foot: string;
  tone: string;
}) {
  return (
    <div className="stat-card">
      <div>
        <span>{label}</span>
        <Icon size={17} strokeWidth={1.6} />
      </div>
      <strong>
        {value}
        <span className={`stat-accent ${tone}`} />
      </strong>
      <p>{foot}</p>
    </div>
  );
}
const priorityRank = (p: string) => (p === 'Urgent' ? 0 : p === 'High' ? 1 : 2);
function ActionList({
  actions,
  data,
  onClick,
}: {
  actions: AppState['actions'];
  data: AppState;
  onClick: (a: AppState['actions'][number]) => void;
}) {
  if (!actions.length)
    return (
      <Empty
        title="You’re all caught up"
        description="New email proposals and meeting requests will appear here."
      />
    );
  return (
    <div className="action-list">
      {actions.map((a) => (
        <button className="action-row" key={a.id} onClick={() => onClick(a)}>
          <div
            className={`action-icon ${a.type.includes('Reschedule') ? 'amber' : a.type.includes('Confirmation') ? 'green' : a.type.includes('request') ? 'blue' : ''}`}
          >
            {a.emailId ? <Mail size={17} /> : <Users size={17} />}
          </div>
          <div className="action-row-content">
            <strong>{a.title}</strong>
            <p>{a.recommendation}</p>
            <span>
              {a.type} <i /> {names(data).user(a.assignedTo)}
            </span>
          </div>
          <div className="action-row-end">
            <Badge>{a.priority}</Badge>
            <ChevronRight size={15} />
          </div>
        </button>
      ))}
    </div>
  );
}
function InboxView({
  data,
  conferenceId,
  search,
  onEmail,
  onAdd,
}: {
  data: AppState;
  conferenceId: string;
  search: string;
  onEmail: (id: string) => void;
  onAdd: () => void;
}) {
  const [category, setCategory] = useState('All categories'),
    [issuer, setIssuer] = useState('All issuers'),
    [status, setStatus] = useState('All statuses');
  const n = names(data);
  const filtered = data.emails.filter(
    (e) =>
      (e.conferenceId === conferenceId || !e.conferenceId) &&
      (category === 'All categories' || e.category === category) &&
      (issuer === 'All issuers' || e.issuerId === issuer) &&
      (status === 'All statuses' || e.status === status) &&
      `${e.subject} ${e.sender} ${e.body}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Email reviews</h1>
          <p>{filtered.length} emails</p>
        </div>
        <Button onClick={onAdd}>
          <Plus size={16} />
          Add email
        </Button>
      </div>
      <div className="panel">
        <div className="panel-toolbar">
          <div className="flex flex-wrap gap-2">
            <select
              className="compact-select"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {[
                'All categories',
                'Issuer Availability Update',
                'New Meeting Request',
                'Meeting Confirmation',
                'Reschedule Request',
                'Meeting Cancellation',
                'General Conference Inquiry',
                'Unrelated Email',
              ].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <select
              className="compact-select"
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
            <select
              className="compact-select"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {[
                'All statuses',
                'Pending review',
                'Approved',
                'Rejected',
                'Clarification requested',
                'Ignored',
              ].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <span className="muted">{filtered.length} emails</span>
        </div>
        {filtered.length ? (
          <div className="inbox-list">
            {filtered.map((e) => (
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
                  <div className="inbox-tags">
                    <Badge tone="gray">{e.category}</Badge>
                    <Badge>{e.status}</Badge>
                  </div>
                </div>
                <ChevronRight size={16} />
              </button>
            ))}
          </div>
        ) : (
          <Empty
            title="No emails match these filters"
            description="Adjust your filters or add a synthetic email to start processing."
          />
        )}
        <div className="table-footer">
          Simulated Outlook inbox<span>Deduplicated by message ID</span>
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
}: {
  data: AppState;
  conferenceId: string;
  search: string;
  onClick: (a: AppState['actions'][number]) => void;
  run: Run;
  onOpenEmails: () => void;
  onOpenDrafts: () => void;
}) {
  const [status, setStatus] = useState('Open');
  const [focus, setFocus] = useState<'all' | 'priority' | 'requests' | 'email'>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const n = names(data);
  const conference = data.conferences.find((item) => item.id === conferenceId)!;
  const emailCount = data.emails.filter(
    (email) => email.conferenceId === conferenceId && email.status === 'Pending review',
  ).length;
  const draftCount = data.drafts.filter((draft) => draft.status === 'Draft').length;
  const actions = data.actions
    .filter(
      (a) =>
        (a.conferenceId === conferenceId || !a.conferenceId) &&
        (status === 'All' || a.status === status) &&
        (focus === 'all' ||
          (focus === 'priority' && ['Urgent', 'High'].includes(a.priority)) ||
          (focus === 'requests' && (a.requestId || /request|alternative/i.test(a.type))) ||
          (focus === 'email' && Boolean(a.emailId))) &&
        `${a.title} ${a.recommendation}`.toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
  const openForConference = data.actions.filter(
    (a) => (a.conferenceId === conferenceId || !a.conferenceId) && a.status === 'Open',
  );
  const priorityCount = openForConference.filter((a) => ['Urgent', 'High'].includes(a.priority)).length;
  const requestCount = openForConference.filter(
    (a) => a.requestId || /request|alternative/i.test(a.type),
  ).length;
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
        <div className={priorityCount ? 'attention' : ''}>
          <strong>{priorityCount}</strong>
          <span>Priority decisions</span>
        </div>
        <div>
          <strong>{requestCount}</strong>
          <span>Investor requests</span>
        </div>
        <div>
          <strong>{emailCount}</strong>
          <span>Email updates</span>
        </div>
        <p><ShieldCheck size={14} /> No schedule changes without your approval</p>
      </div>
      <div className="panel decision-panel">
        <div className="decision-toolbar">
          <div className="decision-filters" aria-label="Filter action queue">
            {([
              ['all', 'All', openForConference.length],
              ['priority', 'Priority', priorityCount],
              ['requests', 'Requests', requestCount],
              ['email', 'Email updates', emailCount],
            ] as const).map(([id, label, count]) => (
              <button key={id} className={focus === id ? 'active' : ''} onClick={() => setFocus(id)}>
                {label} <span>{count}</span>
              </button>
            ))}
          </div>
          <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
            {['Open', 'Resolved', 'Rejected', 'All'].map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>
        <div className="decision-list">
          {actions.map((a) => {
            const request = data.requests.find((item) => item.id === a.requestId);
            const issuer = n.issuer(a.issuerId);
            const investor = n.investor(a.investorId);
            const isPriority = ['Urgent', 'High'].includes(a.priority);
            return (
              <div className={`decision-row ${isPriority ? 'is-priority' : ''}`} key={a.id}>
                <span className="decision-priority-mark" />
                <div className="decision-main">
                  <div className="decision-kicker">
                    {isPriority && <strong>{a.priority}</strong>}
                    <span>{a.type}</span>
                  </div>
                  <h3>
                    {issuer === 'Unassociated' ? a.title : issuer}
                    {issuer !== 'Unassociated' && investor !== '—' && <><i>with</i>{investor}</>}
                  </h3>
                  <p>{a.recommendation}</p>
                  <div className="decision-meta">
                    {request && <span><Clock3 size={12} /> {fmt(request.start, conference.timezone, 'EEE, h:mm a')}</span>}
                    <span>{n.user(a.assignedTo)}</span>
                    <span>{fmt(a.createdAt, undefined, 'MMM d')}</span>
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
