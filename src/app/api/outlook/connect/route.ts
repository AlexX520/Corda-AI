import { banker, currentUser, errorResponse, sameSiteNavigation } from '@/lib/auth';
import { authorizeUrl, newAuthRequest, outlookConfigured, rememberAuth } from '@/lib/graph';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  try {
    sameSiteNavigation(req);
    const user = await currentUser();
    banker(user);
    if (!outlookConfigured()) throw new Error('Add MS_CLIENT_ID to .env, then restart the app.');
    // Behind a hosting proxy the request arrives as plain http; use the forwarded scheme/host.
    const proxied = process.env.TRUST_PROXY === 'true' || Boolean(process.env.VERCEL || process.env.RENDER);
    const host =
      (proxied && req.headers.get('x-forwarded-host')) || req.headers.get('host') || new URL(req.url).host;
    const proto =
      (proxied && req.headers.get('x-forwarded-proto')) || new URL(req.url).protocol.replace(':', '');
    const appOrigin = `${proto}://${host}`;
    const { verifier, challenge, state } = newAuthRequest();
    // The callback may arrive on a different host name (localhost vs 127.0.0.1) or server
    // instance, so the sign-in is matched by its one-time state stored in the database.
    await rememberAuth(state, { userId: user.id, verifier, appOrigin });
    return Response.redirect(authorizeUrl(state, challenge), 302);
  } catch (e) {
    return errorResponse(e);
  }
}
