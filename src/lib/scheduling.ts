import { addMinutes } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
export type Interval = { start: Date | string; end: Date | string };
export const overlaps = (a: Interval, b: Interval) =>
  +new Date(a.start) < +new Date(b.end) && +new Date(b.start) < +new Date(a.end);
export function mergeWindows(windows: Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const w of [...windows].sort((a, b) => +new Date(a.start) - +new Date(b.start))) {
    const last = result[result.length - 1];
    if (last && +new Date(w.start) <= +new Date(last.end))
      last.end = new Date(Math.max(+new Date(last.end), +new Date(w.end)));
    else result.push({ ...w });
  }
  return result;
}
export function isAvailable(slot: Interval, windows: Interval[], busy: Interval[]) {
  return (
    +new Date(slot.end) > +new Date(slot.start) &&
    mergeWindows(windows).some(
      (w) => +new Date(w.start) <= +new Date(slot.start) && +new Date(w.end) >= +new Date(slot.end),
    ) &&
    !busy.some((b) => overlaps(slot, b))
  );
}
export function availableSlots(windows: Interval[], busy: Interval[], duration = 30, step = 30) {
  const slots: Interval[] = [];
  for (const w of mergeWindows(windows)) {
    for (
      let start = new Date(w.start);
      +addMinutes(start, duration) <= +new Date(w.end);
      start = addMinutes(start, step)
    ) {
      const slot = { start: new Date(start), end: addMinutes(start, duration) };
      if (!busy.some((b) => overlaps(slot, b))) slots.push(slot);
    }
  }
  return slots;
}
export function evaluate(
  slot: Interval,
  windows: Interval[],
  busy: Interval[],
  duration: number,
  step = 30,
) {
  const alternatives = availableSlots(windows, busy, duration, step)
    .filter((s) => +new Date(s.start) !== +new Date(slot.start))
    .sort(
      (a, b) =>
        Math.abs(+new Date(a.start) - +new Date(slot.start)) -
        Math.abs(+new Date(b.start) - +new Date(slot.start)),
    )
    .slice(0, 6);
  return {
    status: !windows.length
      ? 'Awaiting Issuer Availability'
      : isAvailable(slot, windows, busy)
        ? 'Potential Match'
        : alternatives.length
          ? 'Alternative Slots Available'
          : 'Conflict',
    alternatives,
  };
}
export function conferenceTime(date: string, time: string, timezone: string) {
  const result = fromZonedTime(`${date}T${time}:00`, timezone);
  if (
    Number.isNaN(+result) ||
    formatInTimeZone(result, timezone, "yyyy-MM-dd'T'HH:mm") !== `${date}T${time}`
  )
    throw new Error('Invalid or nonexistent conference-local date/time.');
  return result;
}
export function validateInterval(
  slot: Interval,
  c: { startDate: string; endDate: string; timezone: string },
) {
  if (
    !Number.isFinite(+new Date(slot.start)) ||
    !Number.isFinite(+new Date(slot.end)) ||
    +new Date(slot.end) <= +new Date(slot.start)
  )
    throw new Error('End time must be after start time.');
  if (
    formatInTimeZone(slot.start, c.timezone, 'yyyy-MM-dd') < c.startDate ||
    formatInTimeZone(slot.end, c.timezone, 'yyyy-MM-dd') > c.endDate
  )
    throw new Error('Time must be within the conference dates.');
}

export type TimelineKind = 'meeting' | 'blocked' | 'hold' | 'available';
export type TimelineSegment = { start: Date; end: Date; kind: TimelineKind; ref?: string };
const RANK: Record<TimelineKind, number> = { meeting: 4, blocked: 3, hold: 2, available: 1 };
/**
 * One resolved timeline for an issuer's day: availability, blocks, holds and meetings merged, with
 * overlapping fragments collapsed. Where several overlap, meeting > blocked > hold > available.
 * Time with nothing recorded is left out (not available).
 */
export function resolveTimeline(items: { start: Date | string; end: Date | string; kind: TimelineKind; ref?: string }[]): TimelineSegment[] {
  const cuts = [...new Set(items.flatMap((i) => [+new Date(i.start), +new Date(i.end)]))].sort((a, b) => a - b);
  const out: TimelineSegment[] = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const [a, b] = [cuts[k], cuts[k + 1]];
    const top = items
      .filter((i) => +new Date(i.start) <= a && +new Date(i.end) >= b)
      .sort((x, y) => RANK[y.kind] - RANK[x.kind])[0];
    if (!top) continue;
    const last = out[out.length - 1];
    if (last && +last.end === a && last.kind === top.kind && last.ref === top.ref) last.end = new Date(b);
    else out.push({ start: new Date(a), end: new Date(b), kind: top.kind, ref: top.ref });
  }
  return out;
}
