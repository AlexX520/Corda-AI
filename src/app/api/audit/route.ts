import { isDesk } from '@/lib/roles';
import { banker, currentUser, errorResponse } from '@/lib/auth';
import { auditCsv, parseAuditQuery, queryAudit } from '@/lib/audit-query';
import { db } from '@/lib/db';
export const dynamic = 'force-dynamic';

/** Audit trail: filtered, paginated JSON, or the full filtered set as CSV (?format=csv). Bankers only. */
export async function GET(req: Request) {
  try {
    const user = await currentUser();
    const params = new URL(req.url).searchParams;
    const query = parseAuditQuery(params);
    if (!isDesk(user.role)) {
      // Sales may read the history of a request or meeting for their own clients, nothing else.
      if (params.get('format') === 'csv' || !(await salesMayRead(user.id, query.request, query.meeting))) banker(user);
      const out = await queryAudit({ ...query, actor: undefined, action: undefined, issuer: undefined, q: undefined, email: undefined });
      return Response.json(
        { ...out, actions: [], actors: [], rows: out.rows.map((r) => ({ ...r, before: null, after: null })) },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    if (params.get('format') === 'csv') {
      const csv = await auditCsv(query);
      await db.auditLog.create({
        data: { actorId: user.id, action: 'Audit trail exported', entityType: 'AuditLog', entityId: 'csv', after: { filters: { ...query, page: undefined, pageSize: undefined } } },
      });
      const stamp = new Date().toISOString().slice(0, 10);
      return new Response(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="Corda-audit-trail-${stamp}.csv"`,
          'Cache-Control': 'no-store',
        },
      });
    }
    return Response.json(await queryAudit(query), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return errorResponse(error);
  }
}

async function salesMayRead(userId: string, requestId?: string, meetingId?: string) {
  if (!requestId === !meetingId) return false;
  const clients = (await db.investor.findMany({ where: { coverageSalesId: userId }, select: { id: true } })).map((x) => x.id);
  if (requestId) {
    const r = await db.meetingRequest.findUnique({ where: { id: requestId } });
    return Boolean(r && (r.salespersonId === userId || clients.includes(r.investorId)));
  }
  const m = await db.meeting.findUnique({ where: { id: meetingId! }, include: { request: true } });
  return Boolean(m && (clients.includes(m.investorId) || m.request?.salespersonId === userId));
}
