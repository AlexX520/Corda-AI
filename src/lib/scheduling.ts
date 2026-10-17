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
