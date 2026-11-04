/**
 * One "now" for the whole app: server time, or DEMO_NOW (ISO timestamp) for a rehearsed demo.
 * Everything that decides past vs future (queue expiry, open slots, My day, allocation) uses it.
 */
export function now(): Date {
  const fixed = process.env.DEMO_NOW;
  if (fixed) {
    const d = new Date(fixed);
    if (!Number.isNaN(+d)) return d;
  }
  return new Date();
}
export const isPast = (end: Date | string, at: Date = now()) => +new Date(end) <= +at;
