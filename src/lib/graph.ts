/**
 * Microsoft Graph (Outlook) connection: delegated sign-in for one mailbox per banker.
 * Reads new Inbox mail with a delta query and sends approved drafts as the signed-in user.
 * Endpoints are overridable (MS_LOGIN_BASE / MS_GRAPH_BASE) so tests can run against a fake server.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const graphScopes = ['offline_access', 'User.Read', 'Mail.Read', 'Mail.Send'];

const loginBase = () => process.env.MS_LOGIN_BASE || 'https://login.microsoftonline.com';
const graphBase = () => process.env.MS_GRAPH_BASE || 'https://graph.microsoft.com/v1.0';
const tenant = () => process.env.MS_TENANT || 'consumers';

export function outlookConfigured() {
  return Boolean(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
}

/** Must match the redirect URI registered in Azure exactly. */
export function redirectUri() {
  return process.env.MS_REDIRECT_URI || 'http://localhost:3000/api/outlook/callback';
}

type PendingAuth = { userId: string; verifier: string; appOrigin: string; at: number };
const pending: Map<string, PendingAuth> = ((globalThis as { __cordaAuth?: Map<string, PendingAuth> }).__cordaAuth ??=
  new Map());
export function rememberAuth(state: string, p: Omit<PendingAuth, 'at'>) {
  for (const [k, v] of pending) if (Date.now() - v.at > 600_000) pending.delete(k);
  pending.set(state, { ...p, at: Date.now() });
}
export function takeAuth(state: string) {
  const p = pending.get(state);
  pending.delete(state);
  return p && Date.now() - p.at < 600_000 ? p : null;
}

const b64url = (buf: Buffer) => buf.toString('base64url');

/** PKCE pair + CSRF state, kept in a short-lived httpOnly cookie between redirect and callback. */
export function newAuthRequest() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  return { verifier, challenge, state };
}

export function authorizeUrl(state: string, challenge: string) {
  const u = new URL(`${loginBase()}/${tenant()}/oauth2/v2.0/authorize`);
  u.searchParams.set('client_id', process.env.MS_CLIENT_ID || '');
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('response_mode', 'query');
  u.searchParams.set('scope', graphScopes.join(' '));
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('prompt', 'select_account');
  return u.toString();
}

type TokenResponse = { access_token: string; refresh_token?: string; expires_in: number };

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID || '',
    client_secret: process.env.MS_CLIENT_SECRET || '',
    scope: graphScopes.join(' '),
    ...params,
  });
  const r = await fetch(`${loginBase()}/${tenant()}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token)
    throw new Error(
      `Microsoft sign-in failed: ${data.error_description?.split('\n')[0] || data.error || r.status}`,
    );
  return data;
}

export const exchangeCode = (code: string, verifier: string) =>
  tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  });

export const refreshAccess = (refreshToken: string) =>
  tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });

/** Refresh tokens are stored encrypted with a key derived from SESSION_SECRET. */
function key() {
  return createHash('sha256').update(`outlook:${process.env.SESSION_SECRET || ''}`).digest();
}
export function seal(text: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b64url).join('.');
}
export function unseal(sealed: string) {
  const [iv, tag, enc] = sealed.split('.').map((s) => Buffer.from(s, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

async function graph<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const url = path.startsWith('http') ? path : `${graphBase()}${path}`;
  const r = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'outlook.body-content-type="text", odata.maxpagesize=50',
      ...(init.headers || {}),
    },
  });
  if (r.status === 202 || r.status === 204) return undefined as T;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Outlook error ${r.status}: ${data?.error?.message || 'request failed'}`);
  return data as T;
}

export const me = (token: string) =>
  graph<{ mail?: string; userPrincipalName?: string; displayName?: string }>(token, '/me');

export type GraphMessage = {
  id: string;
  subject?: string;
  internetMessageId?: string;
  conversationId?: string;
  receivedDateTime?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  toRecipients?: { emailAddress?: { address?: string } }[];
  ccRecipients?: { emailAddress?: { address?: string } }[];
  body?: { contentType?: string; content?: string };
  '@removed'?: unknown;
};

/**
 * One sync round: follows nextLinks until a deltaLink comes back (or the page cap is hit).
 * First run looks back `sinceDays` so a new connection picks up the conference thread so far.
 */
export async function inboxDelta(token: string, deltaLink: string | null, sinceDays = 30, maxPages = 10) {
  let url =
    deltaLink ||
    `/me/mailFolders/inbox/messages/delta?$select=subject,from,toRecipients,ccRecipients,body,receivedDateTime,internetMessageId,conversationId&$filter=receivedDateTime%20ge%20${new Date(
      Date.now() - sinceDays * 864e5,
    ).toISOString()}`;
  const messages: GraphMessage[] = [];
  for (let page = 0; page < maxPages; page++) {
    const data = await graph<{ value: GraphMessage[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string }>(
      token,
      url,
    );
    messages.push(...data.value.filter((m) => !m['@removed']));
    if (data['@odata.deltaLink']) return { messages, deltaLink: data['@odata.deltaLink'] };
    if (!data['@odata.nextLink']) break;
    url = data['@odata.nextLink'];
  }
  // Page cap reached mid-round: keep what we have, resume from the start next time.
  return { messages, deltaLink: deltaLink };
}

const recipients = (list: string[]) => list.map((address) => ({ emailAddress: { address } }));

export async function sendMail(
  token: string,
  m: { to: string[]; cc: string[]; subject: string; body: string; ics?: { name: string; text: string } },
) {
  await graph(token, '/me/sendMail', {
    method: 'POST',
    body: JSON.stringify({
      message: {
        subject: m.subject,
        body: { contentType: 'Text', content: m.body },
        toRecipients: recipients(m.to),
        ccRecipients: recipients(m.cc),
        attachments: m.ics
          ? [
              {
                '@odata.type': '#microsoft.graph.fileAttachment',
                name: m.ics.name,
                contentType: 'text/calendar',
                contentBytes: Buffer.from(m.ics.text).toString('base64'),
              },
            ]
          : [],
      },
      saveToSentItems: true,
    }),
  });
}

/** Reply inside the original Outlook thread so the issuer sees one conversation. */
export async function replyInThread(
  token: string,
  graphId: string,
  m: { to: string[]; cc: string[]; body: string },
) {
  await graph(token, `/me/messages/${encodeURIComponent(graphId)}/reply`, {
    method: 'POST',
    body: JSON.stringify({
      message: { toRecipients: recipients(m.to), ccRecipients: recipients(m.cc) },
      comment: m.body,
    }),
  });
}

export function toIngest(m: GraphMessage, fallbackTo: string) {
  const addr = (x?: { emailAddress?: { address?: string } }) => x?.emailAddress?.address?.toLowerCase() || '';
  const valid = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  const to = (m.toRecipients || []).map(addr).filter(valid);
  return {
    messageId: (m.internetMessageId || m.id).slice(0, 200),
    threadId: (m.conversationId || m.id).slice(0, 200),
    sender: addr(m.from) || fallbackTo,
    to: to.length ? to : [fallbackTo],
    cc: (m.ccRecipients || []).map(addr).filter(valid),
    subject: (m.subject || '(no subject)').slice(0, 500),
    body: (m.body?.content || '').slice(0, 50000) || '(empty message)',
    receivedAt: m.receivedDateTime,
    graphId: m.id,
  };
}
