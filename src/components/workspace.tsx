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
  Boxes,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  CircleHelp,
  Clock3,
  Command,
  FileSpreadsheet,
  Inbox,
  LayoutDashboard,
  Leaf,
  Loader2,
  Mail,
  MapPin,
  MoreHorizontal,
  Plus,
  Search,
  Send,
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
  { id: 'inbox', label: 'AI Inbox', icon: Inbox },
  { id: 'queue', label: 'Action queue', icon: CheckCheck },
  { id: 'availability', label: 'Issuer availability', icon: Clock3 },
  { id: 'requests', label: 'Meeting requests', icon: Users },
  { id: 'resources', label: 'Coverage & resources', icon: Boxes },
  { id: 'planner', label: 'Master schedule', icon: CalendarDays },
];
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
    setPage(id);
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
        <div className="brand-mark">
          <Command size={26} />
        </div>
        <h1>ConferenceOS</h1>
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
          <div className="brand-mark">
            <Command size={23} strokeWidth={1.6} />
          </div>
          <span>
            Conference<span className="brand-os">OS</span>
          </span>
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
            .filter((m) => banker || !['inbox', 'queue', 'resources'].includes(m.id))
            .map((m) => (
              <button
                key={m.id}
                className={page === m.id ? 'nav-item active' : 'nav-item'}
                onClick={() => navigate(m.id)}
              >
                <m.icon size={18} strokeWidth={1.7} />
                <span>{!banker && m.id === 'requests' ? 'Request tracker' : m.label}</span>
                {m.id === 'inbox' && pendingEmails.length > 0 && <b>{pendingEmails.length}</b>}
                {m.id === 'queue' && openActions.length > 0 && (
                  <span className="nav-count">{openActions.length}</span>
                )}
              </button>
            ))}
        </nav>
        <div className="nav-label second">COORDINATION</div>
        <button
          className={`nav-item ${page === 'drafts' ? 'active' : ''}`}
          onClick={() => navigate('drafts')}
        >
          <Send size={18} strokeWidth={1.7} />
          <span>Communications</span>
          {data.drafts.filter((d) => d.status === 'Draft').length > 0 && (
            <span className="nav-count">
              {data.drafts.filter((d) => d.status === 'Draft').length}
            </span>
          )}
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
              {menu.find((m) => m.id === page)?.label ||
                { drafts: 'Communications', audit: 'Audit trail' }[page]}
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
          {page === 'overview' && (
            <>
              <div className="page-heading overview-heading">
                <div>
                  <div className="section-eyebrow">YOUR CONFERENCE, CONNECTED</div>
                  <h1>
                    Let’s make room for opportunity<span>.</span>
                  </h1>
                  <p>
                    Welcome back, {data.user.name.split(' ')[0]}.{' '}
                    {banker ? (
                      <>
                        {openActions.length} items need your attention at {c.name}.
                      </>
                    ) : (
                      'Your investor meetings and the next best opportunities, in one place.'
                    )}
                  </p>
                </div>
                <Button onClick={() => setRequestOpen(true)}>
                  <Plus size={16} />
                  New meeting request
                </Button>
              </div>
              <div className="stats-grid">
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
                  icon={Clock3}
                  label="Available slots"
                  value={data.slots
                    .filter((s) => s.conferenceId === conferenceId)
                    .reduce((acc, s) => acc + s.slots.length, 0)}
                  foot={`${c.slotMinutes}-minute approved windows`}
                  tone="green"
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
              {banker && (
                <div className="intelligence-banner">
                  <div className="sparkle-box">
                    <Sparkles size={21} />
                  </div>
                  <div>
                    <strong>A little less back-and-forth.</strong>
                    <p>
                      {pendingEmails.length} emails analyzed. Review the proposed changes and keep
                      your conference moving.
                    </p>
                  </div>
                  <button onClick={() => navigate('inbox')}>
                    Review AI Inbox <ArrowRight size={16} />
                  </button>
                  <div className="banner-orbits" />
                </div>
              )}
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
                      <p>
                        {banker
                          ? 'The next right action, already surfaced.'
                          : 'Track progress and explore available alternatives.'}
                      </p>
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
                        .slice(0, 5)}
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
                  <div className="panel-bottom">
                    <ShieldCheck size={13} />
                    {banker
                      ? 'Every change is reviewed by you. Nothing is sent automatically.'
                      : 'Available times remain subject to issuer consent.'}
                  </div>
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
          {page === 'inbox' && (
            <InboxView
              data={data}
              conferenceId={conferenceId}
              search={search}
              onEmail={setReviewId}
              onAdd={() => setEmailOpen(true)}
            />
          )}
          {page === 'queue' && (
            <QueueView
              data={data}
              conferenceId={conferenceId}
              search={search}
              onClick={actionClick}
              run={run}
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
          {page === 'planner' && (
            <PlannerView
              key={conferenceId}
              data={data}
              conferenceId={conferenceId}
              search={search}
            />
          )}
          {page === 'resources' && banker && (
            <ResourceAllocationView
              key={conferenceId}
              data={data}
              conferenceId={conferenceId}
              run={run}
            />
          )}
          {page === 'drafts' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="section-eyebrow">REVIEW BEFORE DELIVERY</div>
                  <h1>Communications</h1>
                  <p>Drafts prepared from approved meetings and coordination requests.</p>
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
                  <div className="section-eyebrow">ACCOUNTABILITY BY DESIGN</div>
                  <h1>Audit trail</h1>
                  <p>
                    A durable record of reviews, scheduling decisions, and simulated deliveries.
                  </p>
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
              ConferenceOS <span className="footer-dot">·</span> {c.timezone}
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
        title="Your ConferenceOS workspace"
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
          <div className="section-eyebrow">SIGNAL FROM THE INBOX</div>
          <h1>
            AI Inbox{' '}
            <span className="heading-pill">
              {data.parser === 'Deterministic mock' ? 'Mock parser' : 'AI assisted'}
            </span>
          </h1>
          <p>Your conference emails, organized and ready for a decision.</p>
        </div>
        <Button onClick={onAdd}>
          <Plus size={16} />
          Add email
        </Button>
      </div>
      <div className="notice inbox-notice">
        <Sparkles size={17} />
        <span>
          Extracted changes stay in review until you approve them. Quoted email history is excluded.
        </span>
        <ShieldCheck size={17} />
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
}: {
  data: AppState;
  conferenceId: string;
  search: string;
  onClick: (a: AppState['actions'][number]) => void;
  run: Run;
}) {
  const [status, setStatus] = useState('Open');
  const actions = data.actions
    .filter(
      (a) =>
        (a.conferenceId === conferenceId || !a.conferenceId) &&
        (status === 'All' || a.status === status) &&
        `${a.title} ${a.recommendation}`.toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="section-eyebrow">MAKE THE NEXT RIGHT MOVE</div>
          <h1>Action queue</h1>
          <p>Prioritized decisions that keep your conference moving forward.</p>
        </div>
        <select
          className="compact-select"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          {['Open', 'Resolved', 'Rejected', 'All'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </div>
      <div className="queue-cards">
        {actions.map((a) => (
          <div className="panel queue-card" key={a.id}>
            <div className="flex items-center gap-2">
              <Badge>{a.priority}</Badge>
              <span className="muted">{a.type}</span>
              <Badge>{a.status}</Badge>
            </div>
            <h3>{a.title}</h3>
            <p>{a.recommendation}</p>
            <div className="queue-card-footer">
              <select
                aria-label={`Assign ${a.title}`}
                value={a.assignedTo || ''}
                onChange={(e) =>
                  run(
                    'action',
                    { id: a.id, assignedTo: e.target.value || null },
                    'Coverage assignment updated',
                  )
                }
              >
                <option value="">Unassigned</option>
                {data.users
                  .filter((u) => u.role === 'BANKER')
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
              </select>
              <span>{fmt(a.createdAt, undefined, 'MMM d')}</span>
              <div className="flex gap-2">
                {a.status === 'Open' && (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        run('action', { id: a.id, status: 'Rejected' }, 'Action rejected')
                      }
                    >
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        run(
                          'action',
                          { id: a.id, status: 'Resolved' },
                          'Action resolved. No schedule change applied.',
                        )
                      }
                    >
                      Resolve
                    </Button>
                  </>
                )}
                <Button size="sm" onClick={() => onClick(a)}>
                  Review <ArrowRight size={13} />
                </Button>
              </div>
            </div>
          </div>
        ))}
        {!actions.length && (
          <div className="panel">
            <Empty
              title="Nothing waiting on you"
              description="New proposals and investor requests will appear here automatically."
            />
          </div>
        )}
      </div>
    </>
  );
}
