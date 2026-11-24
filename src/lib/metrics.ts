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
  proposals: {
    status: string;
    editedOnReview: boolean;
    conferenceId: string | null;
    category: string;
    noise?: boolean;
    /** For pending meetings: which ask, from which email, about which pair. */
    id?: string;
    emailId?: string;
    issuerId?: string | null;
    investorId?: string | null;
    reviewNote?: string | null;
    sender?: string;
    receivedAt?: Dateish;
  }[];
  actions: { id: string; type: string; status: string; assignedTo: string | null; createdAt: Dateish; conferenceId: string | null; title: string; proposalId?: string | null }[];
  emails: { id: string; subject: string; sender: string; issuerId: string | null; conferenceId: string | null; status: string; receivedAt: Dateish; escalation: boolean; source: string }[];
  /** Issuers taking part in the event (they sent availability); for the target list. */
  availability?: { conferenceId: string; issuerId: string }[];
  /** Open future slots per issuer in the selected event (service computes them). */
  openSlots?: Record<string, number>;
};

/** How many issuers the target list holds: the ones with the fewest confirmed meetings. */
export const TARGET_COUNT = 3;
const CLOSED_REQUEST = ['Confirmed', 'Cancelled', 'Expired'];
const OPEN_PROPOSAL = ['Pending', 'Clarification requested'];
/**
 * Pending meetings (Alex / Tao, Nov 23): not yet locked in, counted once per meeting.
 *  1 sales passed a request to the desk, the issuer has not confirmed;
 *  2 the issuer wants to move a confirmed meeting, the investor has not confirmed;
 *  3 the other side has answered, the desk has not confirmed yet.
 */
export type PendingItem = {
  key: string;
  stage: 1 | 2 | 3;
  conferenceId: string;
  issuerId: string;
  investorId: string;
  waitingOn: 'Issuer' | 'Investor' | 'Sales' | 'Desk';
  since: string;
  emailId?: string;
  requestId?: string;
};
export function pendingMeetings(x: Pick<MetricsInput, 'requests' | 'meetings' | 'proposals' | 'actions' | 'issuers'>) {
  const items = new Map<string, PendingItem>();
  const put = (it: PendingItem) => {
    const was = items.get(it.key);
    // The furthest stage wins: an issuer's yes on a sales request means the desk is next.
    if (!was || it.stage > was.stage) items.set(it.key, { ...it, requestId: it.requestId || was?.requestId, emailId: it.emailId || was?.emailId });
  };
  const iso = (d: Dateish) => new Date(d).toISOString();
  for (const r of x.requests.filter((q) => !CLOSED_REQUEST.includes(q.status)))
    put({
      key: `new:${r.conferenceId}:${r.issuerId}:${r.investorId}`,
      stage: r.status === 'Awaiting Banker Approval' ? 3 : 1,
      conferenceId: r.conferenceId,
      issuerId: r.issuerId,
      investorId: r.investorId,
      waitingOn: r.status === 'Awaiting Banker Approval' ? 'Desk' : r.status === 'Needs New Time' ? 'Sales' : 'Issuer',
      since: iso(r.createdAt),
      requestId: r.id,
    });
  const issuerDomain = (id: string) => domain(x.issuers.find((i) => i.id === id)?.contactEmail || '');
  for (const p of x.proposals.filter((q) => OPEN_PROPOSAL.includes(q.status) && q.issuerId && q.investorId && q.conferenceId && !q.noise)) {
    const base = { conferenceId: p.conferenceId!, issuerId: p.issuerId!, investorId: p.investorId!, since: iso(p.receivedAt || new Date(0)), emailId: p.emailId };
    const pair = `${p.conferenceId}:${p.issuerId}:${p.investorId}`;
    if (p.category === 'Meeting Confirmation') put({ ...base, key: `new:${pair}`, stage: 3, waitingOn: 'Desk' });
    else if (p.category === 'New Meeting Request') {
      const fromIssuer = !!p.sender && domain(p.sender) === issuerDomain(p.issuerId!);
      put({ ...base, key: `new:${pair}`, stage: 1, waitingOn: fromIssuer ? 'Investor' : 'Issuer' });
    } else if (p.category === 'Reschedule Request') {
      const salesSaidYes = /says the new time works/.test(p.reviewNote || '');
      const askingSales = x.actions.some((a) => a.type === 'Sales check' && OPEN_ACTION.includes(a.status) && a.proposalId === p.id);
      put({ ...base, key: `move:${pair}`, stage: salesSaidYes ? 3 : 2, waitingOn: salesSaidYes ? 'Desk' : askingSales ? 'Investor' : 'Desk' });
    }
  }
  const list = [...items.values()].sort((a, b) => a.stage - b.stage || a.since.localeCompare(b.since));
  // A confirmed meeting being moved counts as pending, not confirmed (so Total never counts it twice).
  const moving = new Set(list.filter((i) => i.key.startsWith('move:')).map((i) => `${i.conferenceId}:${i.issuerId}:${i.investorId}`));
  const confirmed = x.meetings.filter((m) => m.status === 'Confirmed' && !moving.has(`${m.conferenceId}:${m.issuerId}:${m.investorId}`));
  return { items: list, confirmed };
}

/** Documented assumption for the ROI tile: re-keying one ask by hand takes about 6 minutes. */
export const MINUTES_PER_ASK = 6;
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
  const pending = pendingMeetings(x);
  const settled = pending.confirmed;
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
  // "Rejected" is split: noise/phishing (suspicious or unrelated mail) vs real asks the desk declined.
  const emails = {
    approvedClean: reviewed.filter((p) => p.status === 'Approved' && !p.editedOnReview).length,
    approvedEdited: reviewed.filter((p) => p.status === 'Approved' && p.editedOnReview).length,
    rejected: reviewed.filter((p) => p.status === 'Rejected').length,
    rejectedNoise: x.proposals.filter((p) => p.status === 'Rejected' && (p.noise || p.category === 'Unrelated Email')).length,
    declined: reviewed.filter((p) => p.status === 'Rejected' && !p.noise).length,
    pending: reviewed.filter((p) => ['Pending', 'Clarification requested', 'Acknowledged'].includes(p.status)).length,
  };
  // ROI: every ask handled in Corda (approved, declined, handled) saves re-keying it by hand.
  const handled = x.proposals.filter((p) => ['Approved', 'Rejected', 'Resolved'].includes(p.status)).length;
  const roi = { asksHandled: handled, minutesPerAsk: MINUTES_PER_ASK, hoursSaved: Math.round((handled * MINUTES_PER_ASK) / 6) / 10 };

  // Coordinator workload is the bankers' (the manager is not a coordinator).
  const desk = x.users.filter((u) => u.role === 'BANKER');
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
  // Confirmed meetings no banker covers yet (desk head home, "Banker coverage").
  const uncovered = confirmed.filter((m) => !m.bankerIds.length && !x.coverage.some((c) => c.meetingId === m.id)).length;

  // Issuer ranking (confirmed, most first) and the target list: the issuers taking part with the
  // fewest confirmed meetings, so the desk helps them first. Only for one event at a time.
  const issuerRows = x.issuers
    .map((i) => ({
      id: i.id,
      name: i.name,
      confirmed: settled.filter((m) => m.issuerId === i.id).length,
      pending: pending.items.filter((p) => p.issuerId === i.id).length,
      openSlots: x.openSlots?.[i.id] ?? null,
      inEvent:
        (x.availability || []).some((a) => a.issuerId === i.id) || x.meetings.some((m) => m.issuerId === i.id) || x.requests.some((r) => r.issuerId === i.id),
    }))
    .filter((r) => r.inEvent);
  const ranking = [...issuerRows].sort((a, b) => b.confirmed - a.confirmed || b.pending - a.pending || a.name.localeCompare(b.name));
  const targets =
    x.conferences.length === 1
      ? [...issuerRows].sort((a, b) => a.confirmed - b.confirmed || a.pending - b.pending || a.name.localeCompare(b.name)).slice(0, TARGET_COUNT)
      : [];

  return {
    generatedAt: x.now.toISOString(),
    meetings: {
      confirmed: settled.length,
      pending: pending.items.length,
      total: settled.length + pending.items.length,
      pendingByStage: [1, 2, 3].map((s) => pending.items.filter((p) => p.stage === s).length) as [number, number, number],
      pendingItems: pending.items.map((p) => ({
        ...p,
        issuer: x.issuers.find((i) => i.id === p.issuerId)?.name || '',
        investor: x.investors.find((i) => i.id === p.investorId)?.name || '',
      })),
    },
    issuerRanking: ranking.map(({ inEvent: _drop, ...r }) => r),
    targets: targets.map(({ inEvent: _drop, ...r }) => r),
    targetCount: TARGET_COUNT,
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
    roi,
    openByCoordinator,
    unanswered,
    escalations,
    workload,
    uncovered,
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
