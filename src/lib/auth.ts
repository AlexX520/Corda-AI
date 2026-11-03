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
  if (user.role !== 'BANKER') throw new Error('Forbidden');
}
/** State-changing routes accept only same-origin browser requests; a missing Origin is refused. */
export function sameOrigin(req: Request) {
  const origin = req.headers.get('origin');
  if (!origin) throw new Error('Forbidden');
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    throw new Error('Forbidden');
  }
  const allowed = [req.headers.get('x-forwarded-host'), req.headers.get('host'), new URL(req.url).host].filter(Boolean);
  if (!allowed.includes(host)) throw new Error('Forbidden');
}
export function errorResponse(error: unknown) {
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
