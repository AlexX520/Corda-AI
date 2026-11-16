import { cookies } from 'next/headers';
import { z } from 'zod';
import { db } from '@/lib/db';
import { currentUser, errorResponse, readToken, sameOrigin, SESSION_COOKIE, sessionToken } from '@/lib/auth';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    return Response.json({ user: await currentUser() });
  } catch {
    return Response.json({
      user: null,
      demo: process.env.DEMO_MODE === 'true',
      profiles:
        process.env.DEMO_MODE === 'true'
          ? await db.user.findMany({ select: { id: true, name: true, role: true, coordinator: true }, orderBy: [{ role: 'asc' }, { name: 'asc' }] })
          : [],
    });
  }
}
export async function POST(req: Request) {
  try {
    sameOrigin(req);
    if (process.env.DEMO_MODE !== 'true')
      throw new Error('Demo login is disabled. Configure an enterprise identity provider.');
    const { userId } = z.object({ userId: z.string() }).parse(await req.json());
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    (await cookies()).set(SESSION_COOKIE, sessionToken(user.id, user.sessionVersion), {
      httpOnly: true,
      sameSite: 'lax',
      secure: new URL(req.url).protocol === 'https:',
      path: '/',
      maxAge: 86400,
    });
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
/** Sign out: every token issued to this user so far stops working, not just this cookie. */
export async function DELETE(req: Request) {
  try {
    sameOrigin(req);
    const jar = await cookies();
    const session = readToken(jar.get(SESSION_COOKIE)?.value);
    if (session) await db.user.updateMany({ where: { id: session.id }, data: { sessionVersion: { increment: 1 } } });
    jar.delete(SESSION_COOKIE);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
