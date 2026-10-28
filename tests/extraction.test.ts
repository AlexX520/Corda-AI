import test from 'node:test';
import assert from 'node:assert/strict';
import { mockExtract, newEmailContent, extractionSchema } from '../src/lib/extraction';
const ctx = {
  conferences: [
    {
      id: 'abs',
      name: 'ABS East',
      startDate: '2026-10-19',
      endDate: '2026-10-21',
      timezone: 'America/New_York',
    },
  ],
  issuers: [
    { id: 'bayview', name: 'Bayview' },
    { id: 'ford', name: 'Ford Credit' },
  ],
  investors: [{ id: 'pimco', name: 'PIMCO' }],
};
test('sample extracts Monday, preserves Tuesday ambiguity and verifies occupied window', () => {
  const body =
    'Hi, Bayview is available Monday between 3 PM and 5 PM for ABS East. However, we already have a meeting scheduled between 3 PM and 3:30 PM. We can also accommodate meetings Tuesday morning.';
  const e = mockExtract(body, 'Availability', ctx);
  assert.equal(e.windows.length, 2);
  assert.equal(e.windows[0].start, '2026-10-19T19:00:00.000Z');
  assert.equal(e.windows[0].end, '2026-10-19T21:00:00.000Z');
  assert.equal(e.windows[1].kind, 'existingMeeting');
  assert(e.uncertainties.some((s) => s.includes('Tuesday morning')));
  assert.equal(e.needsReview, true);
  assert(e.windows.every((w) => body.includes(w.evidence)));
});
test('quoted historical availability is not applied', () => {
  const body =
    'Thanks for the information.\n\nOn Monday Alex wrote:\n> Bayview is available Monday between 3 PM and 5 PM for ABS East.';
  assert.equal(mockExtract(body, 'Re: conference', ctx).windows.length, 0);
  assert.equal(newEmailContent(body), 'Thanks for the information.');
});
test('does not guess ambiguous entities', () => {
  const e = mockExtract(
    'Bayview and Ford Credit are available Monday between 3 PM and 5 PM at ABS East.',
    'Availability',
    ctx,
  );
  assert.equal(e.issuerId, null);
  assert(e.uncertainties.some((s) => s.includes('Issuer')));
});
test('recognizes replacement, tentative, cancellation, confirmation and reschedule', () => {
  assert.equal(
    mockExtract('Bayview: replace availability Monday between 3 PM and 5 PM ABS East.', '', ctx)
      .operation,
    'replace',
  );
  assert.equal(
    mockExtract('Bayview may be available Monday between 3 PM and 5 PM ABS East.', '', ctx)
      .tentative,
    true,
  );
  assert.equal(
    mockExtract('Cancel Bayview PIMCO meeting at ABS East.', '', ctx).operation,
    'cancel',
  );
  assert.equal(
    mockExtract('Bayview confirms PIMCO Monday between 3 PM and 3:30 PM at ABS East.', '', ctx)
      .operation,
    'confirm',
  );
  assert.equal(
    mockExtract('Reschedule Bayview PIMCO to Monday between 4 PM and 4:30 PM at ABS East.', '', ctx)
      .operation,
    'reschedule',
  );
});
test('rejects unknown structured categories and flags incomplete time', () => {
  assert.throws(() => extractionSchema.parse({ category: 'Invented' }));
  assert.equal(
    mockExtract('Bayview available Monday between 3 and 5 PM ABS East.', '', ctx).windows.length,
    0,
  );
});
test('short conference names resolve to one calendar and mixed weekdays remain uncertain', () => {
  const extended = { ...ctx, conferences: [{ ...ctx.conferences[0], name: 'ABS East 2026' }] };
  assert.equal(
    mockExtract('Bayview available Monday between 3 PM and 5 PM for ABS East.', '', extended)
      .conferenceId,
    'abs',
  );
  const mixed = mockExtract(
    'Bayview is available Monday between 3 PM and 5 PM and Tuesday between 9 AM and 10 AM at ABS East.',
    '',
    ctx,
  );
  assert.equal(mixed.windows.length, 0);
  assert(mixed.uncertainties.some((u) => u.includes('Multiple days')));
});
test('a range like "2–4pm" takes the end time\'s PM for its start', () => {
  const e = mockExtract('Hi, Bayview is available Tuesday Oct 20, 2–4pm for investor meetings at ABS East.', 'Availability', ctx);
  assert.equal(e.windows.length, 1);
  assert.equal(e.windows[0].start, '2026-10-20T18:00:00.000Z');
  assert.equal(e.windows[0].end, '2026-10-20T20:00:00.000Z');
  assert(!e.uncertainties.some((s) => s.includes('AM/PM')));
  const morning = mockExtract('Bayview is available Monday 11-1pm at ABS East.', 'Availability', ctx);
  assert.equal(morning.windows[0].start, '2026-10-19T15:00:00.000Z');
});
test('times the issuer says do not work become unavailable windows', () => {
  const e = mockExtract(
    'Bayview: Monday 10am-1pm does not work for our CFO, but 2-4pm works for ABS East.',
    'Re: investor request',
    ctx,
  );
  assert.equal(e.category, 'Issuer Availability Update');
  assert.deepEqual(
    e.windows.map((w) => [w.kind, w.start]),
    [
      ['unavailable', '2026-10-19T14:00:00.000Z'],
      ['availability', '2026-10-19T18:00:00.000Z'],
    ],
  );
});
test('a block with no offered time is still recorded', () => {
  const e = mockExtract(
    'Unfortunately the Bayview CFO is not available Monday 10am-1pm at ABS East.',
    'Re: request',
    ctx,
  );
  assert.equal(e.windows.length, 1);
  assert.equal(e.windows[0].kind, 'unavailable');
});
test('"no longer" with a new offered time adds that time instead of removing it', () => {
  const e = mockExtract(
    'Bayview can no longer do Tuesday morning. We can take meetings Tuesday 2–4pm instead at ABS East.',
    'Day 2',
    ctx,
  );
  assert.equal(e.operation, 'add');
  assert.equal(e.windows[0].kind, 'availability');
});
