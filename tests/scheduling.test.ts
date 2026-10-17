import test from 'node:test';
import assert from 'node:assert/strict';
import {
  availableSlots,
  conferenceTime,
  evaluate,
  isAvailable,
  mergeWindows,
  overlaps,
  validateInterval,
} from '../src/lib/scheduling';
const slot = (start: string, end: string) => ({
  start: `2026-10-19T${start}:00Z`,
  end: `2026-10-19T${end}:00Z`,
});
test('half-open intervals permit back-to-back meetings', () => {
  assert.equal(overlaps(slot('15:00', '15:30'), slot('15:30', '16:00')), false);
  assert.equal(overlaps(slot('15:00', '15:31'), slot('15:30', '16:00')), true);
});
test('alternatives exclude meetings and holds and honor duration', () => {
  const slots = availableSlots(
    [slot('14:30', '17:00')],
    [slot('15:00', '15:30'), slot('16:00', '16:30')],
    30,
  );
  assert.deepEqual(
    slots.map((s) => new Date(s.start).toISOString().slice(11, 16)),
    ['14:30', '15:30', '16:30'],
  );
  assert.equal(
    availableSlots([slot('14:30', '17:00')], [slot('15:00', '15:30'), slot('16:00', '16:30')], 60)
      .length,
    0,
  );
});
test('overlapping availability is merged without duplicate slots', () => {
  assert.equal(mergeWindows([slot('14:00', '15:00'), slot('14:30', '16:00')]).length, 1);
  assert.equal(availableSlots([slot('14:00', '15:00'), slot('14:30', '16:00')], [], 30).length, 4);
});
test('potential match never implies confirmation', () => {
  assert.equal(
    evaluate(slot('15:00', '15:30'), [slot('14:00', '16:00')], [], 30).status,
    'Potential Match',
  );
  assert.equal(evaluate(slot('15:00', '15:30'), [], [], 30).status, 'Awaiting Issuer Availability');
});
test('requested intervals must fit entirely inside approved availability', () => {
  assert.equal(isAvailable(slot('14:30', '15:30'), [slot('15:00', '16:00')], []), false);
  assert.equal(isAvailable(slot('15:00', '15:00'), [slot('15:00', '16:00')], []), false);
});
test('conference-local date resolves independently of machine timezone', () => {
  assert.equal(
    conferenceTime('2026-10-19', '15:00', 'America/New_York').toISOString(),
    '2026-10-19T19:00:00.000Z',
  );
  assert.equal(
    conferenceTime('2026-11-02', '15:00', 'America/Los_Angeles').toISOString(),
    '2026-11-02T23:00:00.000Z',
  );
});
test('reject nonexistent DST local times and out-of-conference dates', () => {
  assert.throws(() => conferenceTime('2026-03-08', '02:30', 'America/New_York'));
  assert.throws(() =>
    validateInterval(slot('15:00', '15:30'), {
      startDate: '2026-11-01',
      endDate: '2026-11-03',
      timezone: 'America/New_York',
    }),
  );
});
