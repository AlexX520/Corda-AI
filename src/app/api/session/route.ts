import { cookies } from 'next/headers';
import { z } from 'zod';
import { db } from '@/lib/db';
import { currentUser, errorResponse, sameOrigin, sessionToken } from '@/lib/auth';
export async function GET() {
  try {
    return Response.json({ user: await currentUser() });
  } catch {
    return Response.json({
      user: null,
      demo: process.env.DEMO_MODE === 'true',
      profiles:
        process.env.DEMO_MODE === 'true'
          ? await db.user.findMany({ select: { id: true, name: true, role: true } })
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
    (await cookies()).set('conferenceos-session', sessionToken(user.id), {
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
export async function DELETE(req: Request) {
  try {
    sameOrigin(req);
    (await cookies()).delete('conferenceos-session');
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
