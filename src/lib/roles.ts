/** Roles: BANKER (desk), SALES, MANAGER (everything a banker can do, plus team views). */
export type Role = 'BANKER' | 'SALES' | 'MANAGER';
/** Desk roles see and act on the full schedule and queue. */
export const isDesk = (role: string | null | undefined) => role === 'BANKER' || role === 'MANAGER';
export const roleLabel = (role: string) =>
  role === 'MANAGER' ? 'Head of Corporate Access' : role === 'BANKER' ? 'Investment Banking' : 'Institutional Sales';
