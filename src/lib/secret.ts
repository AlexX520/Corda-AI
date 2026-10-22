import { createHash } from 'node:crypto';

/**
 * Server secret for signing sessions and sealing Outlook tokens. Uses SESSION_SECRET when set.
 * On a hosted demo without one, it is derived from the database URL (server-only, contains the
 * database password), so nobody has to create and paste a secret by hand.
 */
export function appSecret() {
  const own = process.env.SESSION_SECRET;
  if (own && own.length >= 32) return own;
  if (own) throw new Error('SESSION_SECRET must be at least 32 characters.');
  const db = process.env.DATABASE_URL;
  if (process.env.VERCEL && db)
    return createHash('sha256').update(`corda-session:${db}`).digest('hex');
  throw new Error('SESSION_SECRET must be at least 32 characters.');
}
