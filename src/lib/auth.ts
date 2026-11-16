import { canOperate, isDesk } from './roles';
import { cookies } from 'next/headers';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { db } from './db';
import { appSecret } from './secret';
const secret = appSecret;
export const SESSION_COOKIE = 'conferenceos-session';
/** Token = user id, the user's session version, expiry, HMAC. Signing out bumps the version. */
export function sessionToken(id: string, version: number) {
  const payload = `${id}.${version}.${Date.now() + 86400000}`;
  return `${payload}.${createHmac('sha256', secret()).update(payload).digest('hex')}`;
}
export function readToken(token: string | undefined) {
  if (!token) return null;
  const [id, version, expires, sig, ...rest] = token.split('.');
  if (rest.length || !id || !version || !expires || !sig || +expires < Date.now()) return null;
  const expected = createHmac('sha256', secret()).update(`${id}.${version}.${expires}`).digest('hex');
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return { id, version: Number(version) };
}
export async function currentUser() {
  const session = readToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) throw new Error('Unauthorized');
  const user = await db.user.findUnique({ where: { id: session.id } });
  if (!user || user.sessionVersion !== session.version) throw new Error('Unauthorized');
  return user;
}
export function banker(user: { role: string }) {
  if (!isDesk(user.role)) throw new Error('Forbidden');
}
/** The origin this request was addressed to. Proxy headers count only when TRUST_PROXY=true. */
function expectedOrigin(req: Request) {
  const url = new URL(req.url);
  const proxied = process.env.TRUST_PROXY === 'true' || Boolean(process.env.VERCEL || process.env.RENDER);
  const proto = (proxied && req.headers.get('x-forwarded-proto')?.split(',')[0].trim()) || url.protocol.replace(':', '');
  const host = (proxied && req.headers.get('x-forwarded-host')?.split(',')[0].trim()) || req.headers.get('host') || url.host;
  return `${proto}://${host}`.toLowerCase();
}
/**
 * State-changing routes accept only same-origin browser requests: the Origin header must match
 * scheme, host and port exactly. A missing or malformed Origin is refused.
 */
export function sameOrigin(req: Request) {
  const origin = req.headers.get('origin');
  if (!origin) throw new Error('Forbidden');
  let actual: string;
  try {
    actual = new URL(origin).origin.toLowerCase();
  } catch {
    throw new Error('Forbidden');
  }
  if (actual !== expectedOrigin(req)) throw new Error('Forbidden');
}
/**
 * For GET routes that start something (e.g. Outlook sign-in): refuse cross-site navigations.
 * Browsers send Sec-Fetch-Site; Origin/Referer, when present, must match exactly.
 */
export function sameSiteNavigation(req: Request) {
  const site = req.headers.get('sec-fetch-site');
  if (site && !['same-origin', 'none'].includes(site)) throw new Error('Forbidden');
  for (const h of ['origin', 'referer']) {
    const v = req.headers.get(h);
    if (!v) continue;
    let o: string;
    try {
      o = new URL(v).origin.toLowerCase();
    } catch {
      throw new Error('Forbidden');
    }
    if (o !== expectedOrigin(req)) throw new Error('Forbidden');
  }
  if (!site && !req.headers.get('origin') && !req.headers.get('referer')) throw new Error('Forbidden');
}
export function errorResponse(error: unknown) {
  // Database errors never reach the client verbatim (they can name tables, columns and values).
  if (error instanceof Error && /^Prisma|PrismaClient/.test(error.name || error.constructor?.name || '')) {
    const notFound = /No .* found|Record to update not found|P2025/.test(error.message);
    if (!notFound) console.error(error);
    return Response.json({ error: notFound ? 'Not found.' : 'The request could not be completed.' }, { status: notFound ? 404 : 400 });
  }
  const message = error instanceof Error ? error.message : 'Unknown error';
  if (error instanceof Error && error.name === 'ZodError') {
    const issues = (error as unknown as { issues: { message: string; path: (string | number)[] }[] }).issues;
    return Response.json(
      { error: issues.map((i) => (i.message.startsWith('Required') || i.message.startsWith('Invalid') ? `${i.path.join('.')}: ${i.message}` : i.message)).join(' ') },
      { status: 400 },
    );
  }
  return Response.json(
    { error: message },
    { status: message === 'Unauthorized' ? 401 : message === 'Forbidden' ? 403 : 400 },
  );
}
/** Acting on the schedule (sync, import, approve): managers and conference coordinators only. */
export function operator(user: { role: string; coordinator?: boolean | null }) {
  if (!canOperate(user)) throw new Error('Only the conference coordinators can do this.');
}
