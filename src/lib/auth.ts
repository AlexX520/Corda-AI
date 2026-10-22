import { cookies } from 'next/headers';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { db } from './db';
import { appSecret } from './secret';
const secret = appSecret;
export function sessionToken(id: string) {
  const payload = `${id}.${Date.now() + 86400000}`;
  return `${payload}.${createHmac('sha256', secret()).update(payload).digest('hex')}`;
}
export async function currentUser() {
  const token = (await cookies()).get('conferenceos-session')?.value;
  if (!token) throw new Error('Unauthorized');
  const [id, expires, sig] = token.split('.');
  if (!id || !expires || !sig || +expires < Date.now()) throw new Error('Unauthorized');
  const expected = createHmac('sha256', secret()).update(`${id}.${expires}`).digest('hex');
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
    throw new Error('Unauthorized');
  const user = await db.user.findUnique({ where: { id } });
  if (!user) throw new Error('Unauthorized');
  return user;
}
export function banker(user: { role: string }) {
  if (user.role !== 'BANKER') throw new Error('Forbidden');
}
export function sameOrigin(req: Request) {
  const origin = req.headers.get('origin');
  if (origin && new URL(origin).host !== (req.headers.get('host') || new URL(req.url).host))
    throw new Error('Forbidden');
}
export function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return Response.json(
    { error: message },
    { status: message === 'Unauthorized' ? 401 : message === 'Forbidden' ? 403 : 400 },
  );
}
