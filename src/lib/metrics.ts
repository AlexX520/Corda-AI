/**
 * Manager metrics, computed from records (never hard-coded). Pure: the service loads the rows,
 * this turns them into the dashboard, and tests feed it fixtures.
 */
type Dateish = Date | string;
const ms = (d: Dateish) => +new Date(d);
const HOUR = 3600000;

export type MetricsInput = {
  now: Date;
  conferences: { id: string; name: string; type: string; startDate: string; endDate: string; location: string }[];
  issuers: { id: string; name: string; contactEmail: string }[];
  investors: { id: string; name: string }[];
  users: { id: string; name: string; role: string }[];
  requests: { id: string; conferenceId: string; issuerId: string; investorId: string; status: string; createdAt: Dateish }[];
  meetings: { id: string; conferenceId: string; issuerId: string; investorId: string; status: string; requestId: string | null; bankerIds: string[]; start: Dateish; createdAt: Dateish }[];
  coverage: { meetingId: string; bankerId: string }[];
  proposals: { status: string; editedOnReview: boolean; conferenceId: string | null; category: string }[];
  actions: { id: string; type: string; status: string; assignedTo: string | null; createdAt: Dateish; conferenceId: string | null; title: string }[];
  emails: { id: string; subject: string; sender: string; issuerId: string | null; conferenceId: string | null; status: string; receivedAt: Dateish; escalation: boolean; source: string }[];
};

export function median(values: number[]) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const domain = (email: string) => email.split('@')[1]?.toLowerCase() || '';
const OPEN_ACTION = ['Open', 'Acknowledged'];
/** Waiting on us (a question we sent back means the issuer was answered). */
const WAITING_EMAIL = ['Pending review'];

export function computeMetrics(x: MetricsInput) {
  const confirmed = x.meetings.filter((m) => m.status === 'Confirmed');
  // Fill rate: of the meetings requested, how many were confirmed.
  const fill = (requests: MetricsInput['requests']) => {
    const requested = requests.length;
    const done = requests.filter((r) => r.status === 'Confirmed').length;
    return { requested, confirmed: done, rate: requested ? done / requested : null };
  };
  // Time to confirm: request created → its meeting created.
  const confirmHours = confirmed
    .filter((m) => m.requestId)
    .map((m) => {
      const r = x.requests.find((q) => q.id === m.requestId);
      return r ? (ms(m.createdAt) - ms(r.createdAt)) / HOUR : null;
    })
    .filter((h): h is number => h !== null && h >= 0);

  const events = [...x.conferences]
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
    .map((c) => {
      const today = x.now.toISOString().slice(0, 10);
      return {
        id: c.id,
        name: c.name,
        type: c.type,
        location: c.location,
        startDate: c.startDate,
        endDate: c.endDate,
        state: today < c.startDate ? 'Upcoming' : today > c.endDate ? 'Done' : 'Live',
        meetings: confirmed.filter((m) => m.conferenceId === c.id).length,
        ...fill(x.requests.filter((r) => r.conferenceId === c.id)),
        openItems: x.actions.filter((a) => a.conferenceId === c.id && OPEN_ACTION.includes(a.status)).length,
      };
    });

  const per = <T extends { id: string; name: string }>(list: T[], key: 'issuerId' | 'investorId') =>
    list
      .map((p) => ({
        id: p.id,
        name: p.name,
        meetings: confirmed.filter((m) => m[key] === p.id).length,
        requested: x.requests.filter((r) => r[key] === p.id).length,
      }))
      .filter((p) => p.meetings || p.requested)
      .sort((a, b) => b.meetings - a.meetings || b.requested - a.requested || a.name.localeCompare(b.name));

  // Email handling: approved as read, approved after the reviewer edited, rejected.
  const reviewed = x.proposals.filter((p) => p.category !== 'Unrelated Email');
  const emails = {
    approvedClean: reviewed.filter((p) => p.status === 'Approved' && !p.editedOnReview).length,
    approvedEdited: reviewed.filter((p) => p.status === 'Approved' && p.editedOnReview).length,
    rejected: reviewed.filter((p) => p.status === 'Rejected').length,
    pending: reviewed.filter((p) => ['Pending', 'Clarification requested', 'Acknowledged'].includes(p.status)).length,
  };

  const desk = x.users.filter((u) => u.role === 'BANKER' || u.role === 'MANAGER');
  const open = x.actions.filter((a) => OPEN_ACTION.includes(a.status));
  const owners = [...new Set(open.map((a) => a.assignedTo))];
  const openByCoordinator = owners
    .map((id) => {
      const mine = open.filter((a) => a.assignedTo === id);
      const oldest = Math.min(...mine.map((a) => ms(a.createdAt)));
      return {
        userId: id,
        name: id ? x.users.find((u) => u.id === id)?.name || 'Unknown' : 'Unassigned',
        open: mine.length,
        oldestHours: Math.round((ms(x.now) - oldest) / HOUR),
      };
    })
    .sort((a, b) => b.open - a.open || b.oldestHours - a.oldestHours);

  // Issuer emails nobody has answered for more than 4 hours.
  const unanswered = x.emails
    .filter((e) => {
      const issuer = x.issuers.find((i) => i.id === e.issuerId);
      return issuer && domain(e.sender) === domain(issuer.contactEmail) && WAITING_EMAIL.includes(e.status) && ms(x.now) - ms(e.receivedAt) > 4 * HOUR;
    })
    .sort((a, b) => ms(a.receivedAt) - ms(b.receivedAt))
    .map((e) => ({
      id: e.id,
      subject: e.subject,
      issuer: x.issuers.find((i) => i.id === e.issuerId)?.name || '',
      ageHours: Math.round((ms(x.now) - ms(e.receivedAt)) / HOUR),
    }));

  const escalations = open.filter((a) => /escalation/i.test(a.type)).map((a) => ({ id: a.id, title: a.title, owner: x.users.find((u) => u.id === a.assignedTo)?.name || 'Unassigned', ageHours: Math.round((ms(x.now) - ms(a.createdAt)) / HOUR) }));

  const nowMs = ms(x.now);
  const workload = desk
    .map((u) => {
      const covered = confirmed.filter((m) => m.bankerIds.includes(u.id) || x.coverage.some((c) => c.meetingId === m.id && c.bankerId === u.id));
      return {
        userId: u.id,
        name: u.name,
        meetings: covered.length,
        next7Days: covered.filter((m) => ms(m.start) >= nowMs && ms(m.start) < nowMs + 7 * 24 * HOUR).length,
        openItems: open.filter((a) => a.assignedTo === u.id).length,
      };
    })
    .sort((a, b) => b.meetings + b.openItems - (a.meetings + a.openItems));

  return {
    generatedAt: x.now.toISOString(),
    totals: {
      meetings: confirmed.length,
      ...fill(x.requests),
      medianHoursToConfirm: median(confirmHours),
      confirmedFromRequests: confirmHours.length,
      openItems: open.length,
      escalationsOpen: escalations.length,
      unansweredIssuerEmails: unanswered.length,
    },
    events,
    perIssuer: per(x.issuers, 'issuerId'),
    perInvestor: per(x.investors, 'investorId'),
    emails,
    openByCoordinator,
    unanswered,
    escalations,
    workload,
    demoRecords: x.emails.filter((e) => e.source === 'demo-history').length,
  };
}
export type Metrics = ReturnType<typeof computeMetrics>;

/** Did the reviewer change what Corda read? (Who/what/when; not the reviewer's meeting pick.) */
export function extractionEdited(before: unknown, after: unknown) {
  const key = (e: unknown) => {
    const x = (e || {}) as Record<string, unknown>;
    const windows = Array.isArray(x.windows)
      ? (x.windows as Record<string, unknown>[]).map((w) => [w.start, w.end, w.kind].join('|')).sort()
      : [];
    return JSON.stringify([x.category, x.operation, x.issuerId, x.investorId, x.conferenceId, x.attendees ?? null, windows]);
  };
  return key(before) !== key(after);
}
