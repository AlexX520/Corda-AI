/**
 * Caps on issuer-level preferences per banker per event, so "everything is high priority" cannot
 * happen and allocation has something to weigh (Tao, Nov 18). Levels not listed are unlimited.
 */
export const PREFERENCE_LIMITS: Record<string, number> = { 'Must Attend': 2, 'High Priority': 3 };

const short = (level: string) => level.replace(' Attend', '').replace(' Priority', '').toLowerCase();

/** The first cap a set of levels breaks, as a sentence, or null when it fits. */
export function preferenceLimitError(levels: string[]): string | null {
  for (const [level, max] of Object.entries(PREFERENCE_LIMITS)) {
    const n = levels.filter((l) => l === level).length;
    if (n > max) return `At most ${max} ${short(level)} per event (${n} chosen). Move the rest to a lower level.`;
  }
  return null;
}

/** "Must 1/2 · High 3/3" for the form footer. */
export const preferenceUsage = (levels: string[]) =>
  Object.entries(PREFERENCE_LIMITS)
    .map(([level, max]) => `${short(level).replace(/^\w/, (x) => x.toUpperCase())} ${levels.filter((l) => l === level).length}/${max}`)
    .join(' · ');
