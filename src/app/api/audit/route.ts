import { banker, currentUser, errorResponse } from '@/lib/auth';
import { auditCsv, parseAuditQuery, queryAudit } from '@/lib/audit-query';
import { db } from '@/lib/db';
export const dynamic = 'force-dynamic';

/** Audit trail: filtered, paginated JSON, or the full filtered set as CSV (?format=csv). Bankers only. */
export async function GET(req: Request) {
  try {
    const user = await currentUser();
    banker(user);
    const params = new URL(req.url).searchParams;
    const query = parseAuditQuery(params);
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
