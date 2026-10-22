export const dynamic = 'force-dynamic';
/** Liveness check for hosting platforms; no data, no auth. */
export function GET() {
  return Response.json({ ok: true });
}
