import { db } from '@/lib/db';
import { redirectUri, takeAuth } from '@/lib/graph';
import { command } from '@/lib/service';
import { connectOutlook, syncOutlook } from '@/lib/outlook-service';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function GET(req: Request) {
  const url = new URL(req.url);
  const pending = await takeAuth(url.searchParams.get('state') || '').catch(() => null);
  const home = pending?.appOrigin || new URL(redirectUri()).origin;
  const back = (status: string, message?: string) =>
    Response.redirect(
      `${home}/?outlook=${status}${message ? `&message=${encodeURIComponent(message)}` : ''}`,
      302,
    );
  try {
    if (url.searchParams.get('error'))
      return back('error', url.searchParams.get('error_description') || 'Sign-in was cancelled.');
    const code = url.searchParams.get('code');
    if (!pending || !code) return back('error', 'Sign-in expired. Try Connect Outlook again.');
    const user = await db.user.findUniqueOrThrow({ where: { id: pending.userId } });
    await connectOutlook(user.id, code, pending.verifier);
    await syncOutlook(user, (input) => command(user, 'ingest', input)).catch(() => undefined);
    return back('connected');
  } catch (e) {
    return back('error', e instanceof Error ? e.message : 'Could not connect Outlook.');
  }
}
