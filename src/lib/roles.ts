/** Roles: BANKER (desk), SALES, MANAGER (everything a banker can do, plus team views). */
export type Role = 'BANKER' | 'SALES' | 'MANAGER';
/** Desk roles see and act on the full schedule and queue. */
export const isDesk = (role: string | null | undefined) => role === 'BANKER' || role === 'MANAGER';
export const roleLabel = (role: string) =>
  role === 'MANAGER' ? 'Head of Corporate Access' : role === 'BANKER' ? 'Investment Banking' : 'Institutional Sales';
/**
 * Who may act on the schedule: managers and the conference coordinators. Other bankers view the
 * schedule and set their own coverage preferences (Alex, Nov 16: "only a few people operate").
 */
export const canOperate = (user: { role: string; coordinator?: boolean | null } | null | undefined) =>
  Boolean(user && (user.role === 'MANAGER' || (user.role === 'BANKER' && user.coordinator)));
/** Commands any banker may run for themselves (everything else needs canOperate). */
export const SELF_SERVICE_COMMANDS = new Set([
  'saveCoveragePreferences',
  'saveBankerAvailability',
  'markSeen',
  'notificationsRead',
  'ask',
  'ping',
  'llmCheck',
]);
/**
 * Allocation (run it, approve it, edit its results, rooms, locks, coverage needs) is the manager's job
 * (Tao, Nov 17, from the Stonefield review): bankers, coordinators included, view the result and set
 * their own preferences.
 */
export const ALLOCATION_COMMANDS = new Set([
  'optimizeConference',
  'approveAllocationRun',
  'updateAllocationProposal',
  'saveMeetingCube',
  'saveCoverageRequirement',
  'toggleCoverageLock',
  'toggleRoomLock',
]);
export const canAllocate = (user: { role: string } | null | undefined) => user?.role === 'MANAGER';
