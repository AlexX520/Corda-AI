import { Prisma } from '@prisma/client';
import { formatInTimeZone } from 'date-fns-tz';
import { z } from 'zod';
import { db } from './db';

/** Filters for the audit trail page and its CSV export. Dates are yyyy-mm-dd (inclusive). */
export const auditQuerySchema = z.object({
  q: z.string().max(200).optional(),
  actor: z.string().max(100).optional(),
  action: z.string().max(200).optional(),
  issuer: z.string().max(100).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** History of one record: a meeting (incl. its request and source email), a request, or an email. */
  meeting: z.string().max(100).optional(),
  request: z.string().max(100).optional(),
  email: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(10).max(500).default(50),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export type AuditRow = {
  id: string;
  createdAt: string;
  action: string;
  actor: string;
  actorId: string;
  entityType: string;
  entity: string;
  issuer: string | null;
  note: string | null;
  emailId: string | null;
  meetingId: string | null;
  before: Prisma.JsonValue;
  after: Prisma.JsonValue;
};

export function parseAuditQuery(params: URLSearchParams): AuditQuery {
  const raw: Record<string, string> = {};
  for (const [k, v] of params) if (v !== '') raw[k] = v;
  return auditQuerySchema.parse(raw);
}

async function where(p: AuditQuery): Promise<Prisma.AuditLogWhereInput> {
  const and: Prisma.AuditLogWhereInput[] = [];
  if (p.actor) and.push({ actorId: p.actor });
  if (p.action) and.push({ action: p.action });
  if (p.issuer) {
    // Older rows only have the meeting; match those through the meeting's issuer too.
    const meetings = await db.meeting.findMany({ where: { issuerId: p.issuer }, select: { id: true } });
    and.push({ OR: [{ issuerId: p.issuer }, { meetingId: { in: meetings.map((m) => m.id) } }, { entityId: p.issuer }] });
  }
  if (p.meeting) {
    const m = await db.meeting.findUnique({ where: { id: p.meeting }, select: { requestId: true, sourceEmailId: true } });
    and.push({
      OR: [
        { meetingId: p.meeting },
        { entityId: p.meeting },
        ...(m?.requestId ? [{ entityId: m.requestId }] : []),
        ...(m?.sourceEmailId ? [{ emailId: m.sourceEmailId, entityType: 'Proposal' }] : []),
      ],
    });
  }
  if (p.request) {
    const meetings = await db.meeting.findMany({ where: { requestId: p.request }, select: { id: true } });
    and.push({ OR: [{ entityId: p.request }, { meetingId: { in: meetings.map((m) => m.id) } }] });
  }
  if (p.email) and.push({ OR: [{ emailId: p.email }, { entityId: p.email }] });
  if (p.from) and.push({ createdAt: { gte: new Date(`${p.from}T00:00:00Z`) } });
  if (p.to) and.push({ createdAt: { lt: new Date(+new Date(`${p.to}T00:00:00Z`) + 86400000) } });
  const q = p.q?.trim();
  if (q) {
    const like = { contains: q, mode: 'insensitive' as const };
    const [issuers, investors, emails, users] = await Promise.all([
      db.issuer.findMany({ where: { name: like }, select: { id: true } }),
      db.investor.findMany({ where: { name: like }, select: { id: true } }),
      db.email.findMany({ where: { OR: [{ subject: like }, { sender: like }] }, select: { id: true } }),
      db.user.findMany({ where: { name: like }, select: { id: true } }),
    ]);
    const meetings = await db.meeting.findMany({
      where: { OR: [{ issuerId: { in: issuers.map((i) => i.id) } }, { investorId: { in: investors.map((i) => i.id) } }] },
      select: { id: true },
    });
    and.push({
      OR: [
        { action: like },
        { note: like },
        { entityType: like },
        { actorId: { in: users.map((u) => u.id) } },
        { issuerId: { in: issuers.map((i) => i.id) } },
        { meetingId: { in: meetings.map((m) => m.id) } },
        { emailId: { in: emails.map((e) => e.id) } },
      ],
    });
  }
  return and.length ? { AND: and } : {};
}

/** Readable rows: names instead of ids, the reason, and the email / meeting it links to. */
async function label(rows: Awaited<ReturnType<typeof db.auditLog.findMany>>): Promise<AuditRow[]> {
  const ids = (k: 'meetingId' | 'emailId') => [...new Set(rows.map((r) => r[k]).filter(Boolean) as string[])];
  const entityIds = (t: string) => rows.filter((r) => r.entityType === t).map((r) => r.entityId);
  const [users, issuers, investors, conferences, meetings, emails, proposals, requests, drafts, actions] = await Promise.all([
    db.user.findMany({ select: { id: true, name: true } }),
    db.issuer.findMany({ select: { id: true, name: true } }),
    db.investor.findMany({ select: { id: true, name: true } }),
    db.conference.findMany({ select: { id: true, name: true, timezone: true } }),
    db.meeting.findMany({ where: { id: { in: [...ids('meetingId'), ...entityIds('Meeting')] } } }),
    db.email.findMany({ where: { id: { in: [...ids('emailId'), ...entityIds('Email')] } }, select: { id: true, subject: true } }),
    db.proposal.findMany({ where: { id: { in: entityIds('Proposal') } }, select: { id: true, emailId: true, summary: true } }),
    db.meetingRequest.findMany({ where: { id: { in: entityIds('MeetingRequest') } }, select: { id: true, issuerId: true, investorId: true } }),
    db.draft.findMany({ where: { id: { in: entityIds('Draft') } }, select: { id: true, subject: true } }),
    db.action.findMany({ where: { id: { in: entityIds('Action') } }, select: { id: true, title: true } }),
  ]);
  const name = <T extends { id: string; name: string }>(list: T[], id?: string | null) => (id ? list.find((x) => x.id === id)?.name : undefined);
  const meetingLabel = (id: string) => {
    const m = meetings.find((x) => x.id === id);
    if (!m) return 'Meeting (removed)';
    const tz = conferences.find((c) => c.id === m.conferenceId)?.timezone || 'America/New_York';
    return `${name(issuers, m.issuerId)} × ${name(investors, m.investorId)} · ${formatInTimeZone(m.start, tz, 'EEE MMM d h:mm a')}`;
  };
  const entity = (r: (typeof rows)[number]) => {
    switch (r.entityType) {
      case 'Meeting':
        return meetingLabel(r.entityId);
      case 'Email':
        return emails.find((e) => e.id === r.entityId)?.subject || 'Email';
      case 'Proposal': {
        const p = proposals.find((x) => x.id === r.entityId);
        return p?.summary || 'Email ask';
      }
      case 'MeetingRequest': {
        const q = requests.find((x) => x.id === r.entityId);
        return q ? `${name(investors, q.investorId)} → ${name(issuers, q.issuerId)} request` : 'Meeting request';
      }
      case 'Draft':
        return drafts.find((x) => x.id === r.entityId)?.subject || 'Draft';
      case 'Action':
        return actions.find((x) => x.id === r.entityId)?.title || 'Queue item';
      case 'Conference':
        return name(conferences, r.entityId) || 'Conference';
      case 'Issuer':
      case 'Availability':
        return name(issuers, r.entityId) ? `${name(issuers, r.entityId)}${r.entityType === 'Availability' ? ' availability' : ''}` : r.entityType;
      default:
        return r.entityType.replace(/([a-z])([A-Z])/g, '$1 $2');
    }
  };
  return rows.map((r) => {
    const after = r.after as Record<string, unknown> | null;
    const proposalEmail = r.entityType === 'Proposal' ? proposals.find((x) => x.id === r.entityId)?.emailId : null;
    return {
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      action: r.action,
      actor: name(users, r.actorId) || 'System',
      actorId: r.actorId,
      entityType: r.entityType,
      entity: entity(r),
      issuer: name(issuers, r.issuerId) || null,
      note: r.note || (typeof after?.reason === 'string' ? after.reason : null),
      emailId: r.emailId || proposalEmail || null,
      meetingId: r.meetingId || null,
      before: r.before,
      after: r.after,
    };
  });
}

export async function queryAudit(p: AuditQuery) {
  const w = await where(p);
  const [total, rows, actions, actors] = await Promise.all([
    db.auditLog.count({ where: w }),
    db.auditLog.findMany({ where: w, orderBy: { createdAt: 'desc' }, skip: (p.page - 1) * p.pageSize, take: p.pageSize }),
    db.auditLog.findMany({ distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } }),
    db.auditLog.findMany({ distinct: ['actorId'], select: { actorId: true } }),
  ]);
  const users = await db.user.findMany({ where: { id: { in: actors.map((a) => a.actorId) } }, select: { id: true, name: true } });
  return {
    rows: await label(rows),
    total,
    page: p.page,
    pageSize: p.pageSize,
    pages: Math.max(1, Math.ceil(total / p.pageSize)),
    actions: actions.map((a) => a.action),
    actors: users.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

const csvCell = (v: unknown) => {
  let s = v == null ? '' : String(v);
  if (/^[=+@-]/.test(s)) s = `'${s}`; // no spreadsheet formulas
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** All matching rows (not just one page), newest first. */
export async function auditCsv(p: AuditQuery) {
  const w = await where(p);
  const out = [['Time (UTC)', 'Action', 'Actor', 'Record type', 'Record', 'Issuer', 'Reason / note', 'Email id', 'Meeting id'].join(',')];
  for (let skip = 0; ; skip += 1000) {
    const batch = await db.auditLog.findMany({ where: w, orderBy: { createdAt: 'desc' }, skip, take: 1000 });
    for (const r of await label(batch))
      out.push([r.createdAt, r.action, r.actor, r.entityType, r.entity, r.issuer, r.note, r.emailId, r.meetingId].map(csvCell).join(','));
    if (batch.length < 1000) break;
  }
  return out.join('\r\n') + '\r\n';
}
