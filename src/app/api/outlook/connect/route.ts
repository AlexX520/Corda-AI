import { banker, currentUser, errorResponse } from '@/lib/auth';
import { authorizeUrl, newAuthRequest, outlookConfigured, rememberAuth } from '@/lib/graph';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  try {
    const user = await currentUser();
    banker(user);
    if (!outlookConfigured())
      throw new Error('Add MS_CLIENT_ID and MS_CLIENT_SECRET to .env, then restart the app.');
    const host = req.headers.get('host') || new URL(req.url).host;
    const appOrigin = `${new URL(req.url).protocol}//${host}`;
    const { verifier, challenge, state } = newAuthRequest();
    // The callback may arrive on a different host name (localhost vs 127.0.0.1), so the
    // sign-in is matched by its one-time state, not by a cookie.
    rememberAuth(state, { userId: user.id, verifier, appOrigin });
    return Response.redirect(authorizeUrl(state, challenge), 302);
  } catch (e) {
    return errorResponse(e);
  }
}
