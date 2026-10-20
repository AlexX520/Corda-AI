import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequestText } from '../src/lib/request-parser';
const ctx = {
  conference: { startDate: '2026-10-19', endDate: '2026-10-21', slotMinutes: 30 },
  issuers: [
    { id: 'bayview', name: 'Bayview' },
    { id: 'ford', name: 'Ford Credit' },
    { id: 'onemain', name: 'OneMain Financial' },
  ],
  investors: [
    { id: 'ford-investor', name: 'Ford Credit' },
    { id: 'trowe', name: 'T. Rowe Price' },
  ],
};
test('desk shorthand: issuer / investor, window, weekday', () => {
  const p = parseRequestText('Bayview / ford looking to meet at 3-4pm monday?', ctx);
  assert.equal(p.issuerId, 'bayview');
  assert.equal(p.investorId, 'ford-investor');
  assert.equal(p.date, '2026-10-19');
  assert.equal(p.windowStart, '15:00');
  assert.equal(p.windowEnd, '16:00');
  assert.deepEqual(p.missing, []);
});
test('range crossing noon keeps the morning start', () => {
  const p = parseRequestText('OneMain wants T. Rowe Price tues 11-1pm', ctx);
  assert.equal(p.windowStart, '11:00');
  assert.equal(p.windowEnd, '13:00');
  assert.equal(p.date, '2026-10-20');
});
test('lists what is missing instead of guessing', () => {
  const p = parseRequestText('Bayview would like a meeting', ctx);
  assert.deepEqual(p.missing, ['investor', 'day', 'time']);
});
