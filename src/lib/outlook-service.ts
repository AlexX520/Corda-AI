import type { User } from '@prisma/client';
import { db } from './db';
import {
  exchangeCode,
  inboxDelta,
  me,
  outlookConfigured,
  refreshAccess,
  seal,
  toIngest,
  unseal,
} from './graph';

/** In-memory access-token cache; refresh tokens live encrypted in the database. */
const cache = new Map<string, { token: string; expires: number }>();

export async function connectOutlook(userId: string, code: string, verifier: string) {
  const t = await exchangeCode(code, verifier);
  if (!t.refresh_token)
    throw new Error('Microsoft did not return offline access. Try connecting again.');
  const profile = await me(t.access_token);
  const email = (profile.mail || profile.userPrincipalName || '').toLowerCase();
  cache.set(userId, { token: t.access_token, expires: Date.now() + (t.expires_in - 120) * 1000 });
  await db.outlookAccount.upsert({
    where: { userId },
    create: {
      userId,
      email,
      displayName: profile.displayName || '',
      refreshToken: seal(t.refresh_token),
    },
    update: {
      email,
      displayName: profile.displayName || '',
      refreshToken: seal(t.refresh_token),
      deltaLink: null,
      lastError: null,
    },
  });
}

export async function accessTokenFor(userId: string) {
  if (!outlookConfigured()) return null;
  const hit = cache.get(userId);
  if (hit && hit.expires > Date.now()) return hit.token;
  const account = await db.outlookAccount.findUnique({ where: { userId } });
  if (!account) return null;
  const t = await refreshAccess(unseal(account.refreshToken));
  cache.set(userId, { token: t.access_token, expires: Date.now() + (t.expires_in - 120) * 1000 });
  if (t.refresh_token)
    await db.outlookAccount.update({
      where: { userId },
      data: { refreshToken: seal(t.refresh_token) },
    });
  return t.access_token;
}

export async function disconnectOutlook(userId: string) {
  cache.delete(userId);
  await db.outlookAccount.deleteMany({ where: { userId } });
}

/**
 * Pull new Inbox mail and run each message through the normal ingest pipeline.
 * `ingest` is passed in to avoid a circular import with service.ts.
 */
export async function syncOutlook(
  user: User,
  ingest: (input: unknown) => Promise<unknown>,
): Promise<{ imported: number; skipped: number; duplicates: number }> {
  const account = await db.outlookAccount.findUnique({ where: { userId: user.id } });
  if (!account) throw new Error('Connect Outlook first.');
  try {
    const token = await accessTokenFor(user.id);
    if (!token) throw new Error('Outlook is not configured on this server.');
    const { messages, deltaLink } = await inboxDelta(token, account.deltaLink);
    let imported = 0,
      skipped = 0,
      duplicates = 0;
    for (const m of messages) {
      const input = toIngest(m, account.email || user.email);
      if (await db.email.findUnique({ where: { messageId: input.messageId } })) {
        duplicates++;
        continue;
      }
      try {
        const saved = await ingest({ ...input, source: 'outlook', skipUnrelated: true });
        if (saved) imported++;
        else skipped++;
      } catch {
        skipped++;
      }
    }
    await db.outlookAccount.update({
      where: { userId: user.id },
      data: { deltaLink, lastSyncAt: new Date(), lastSyncCount: imported, lastError: null },
    });
    return { imported, skipped, duplicates };
  } catch (e) {
    await db.outlookAccount.update({
      where: { userId: user.id },
      data: { lastError: e instanceof Error ? e.message : 'Sync failed', lastSyncAt: new Date() },
    });
    throw e;
  }
}

export async function outlookStatus(userId: string) {
  const account = await db.outlookAccount.findUnique({ where: { userId } });
  return {
    configured: outlookConfigured(),
    connected: Boolean(account),
    email: account?.email || null,
    displayName: account?.displayName || null,
    lastSyncAt: account?.lastSyncAt?.toISOString() || null,
    lastSyncCount: account?.lastSyncCount || 0,
    lastError: account?.lastError || null,
  };
}
