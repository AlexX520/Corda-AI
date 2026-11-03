/** The OpenAI-compatible path must accept the multi-ask format (model answer mocked). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractEmail } from '../src/lib/extraction';

const ctx = {
  conferences: [
    {
      id: 'abs-east',
      name: 'ABS East 2026',
      startDate: '2026-10-19',
      endDate: '2026-10-21',
      timezone: 'America/New_York',
    },
  ],
  issuers: [{ id: 'ford', name: 'Ford Credit' }],
  investors: [
    { id: 'blackrock', name: 'BlackRock' },
    { id: 'pimco', name: 'PIMCO' },
  ],
};
const body =
  '1) BlackRock - can we move that to Tuesday 2:00pm ET?\n2) PIMCO on Tuesday 1pm - please cancel.';
function mockModel(answer: unknown, ok = true) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify(
        ok
          ? { choices: [{ message: { content: JSON.stringify(answer) } }] }
          : { error: { message: 'down' } },
      ),
      {
        status: ok ? 200 : 503,
      },
    )) as typeof fetch;
  process.env.LLM_API_KEY = 'test';
  return () => {
    globalThis.fetch = original;
    delete process.env.LLM_API_KEY;
  };
}

test('LLM answer with several asks is normalised (local times, evidence repaired, referenceTime)', async () => {
  const restore = mockModel({
    asks: [
      {
        category: 'Reschedule Request',
        conferenceId: 'abs-east',
        issuerId: 'ford',
        investorId: 'blackrock',
        operation: 'reschedule',
        tentative: false,
        windows: [
          {
            date: '2026-10-20',
            startTime: '14:00',
            endTime: '14:30',
            kind: 'existingMeeting',
            evidence: 'BlackRock - can we move that to Tuesday 2:00pm ET',
          },
        ],
        referenceTime: { date: '2026-10-19', time: '10:00' },
        uncertainties: [],
        evidence: ['BlackRock - can we move that to Tuesday 2:00pm ET?'],
        needsReview: true,
        meetingId: 'invented',
        summary: 'Move BlackRock to Tue 2pm',
        attendees: null,
        durationMinutes: null,
        vague: [],
      },
      {
        category: 'Meeting Cancellation',
        conferenceId: 'abs-east',
        issuerId: 'ford',
        investorId: 'pimco',
        operation: 'cancel',
        tentative: false,
        windows: [],
        referenceTime: { date: '2026-10-20', time: '13:00' },
        uncertainties: [],
        evidence: ['PIMCO on Tuesday 1pm - please cancel.'],
        needsReview: true,
        meetingId: null,
        summary: 'Cancel PIMCO',
        vague: ['not in the email'],
      },
    ],
  });
  try {
    const r = await extractEmail(body, 'Ford updates', ctx);
    assert.equal(r.parser, 'llm');
    assert.equal(r.asks.length, 2);
    const [move, cancel] = r.asks;
    assert.equal(move.windows[0].start, '2026-10-20T18:00:00.000Z');
    assert.equal(
      move.windows[0].kind,
      'availability',
      'the new slot of a reschedule is the proposed time',
    );
    assert(body.includes(move.windows[0].evidence));
    assert.equal(move.meetingId, null, 'the model never picks the meeting');
    assert.equal(move.referenceTime, '2026-10-19T14:00:00.000Z');
    assert.equal(cancel.operation, 'cancel');
    assert.deepEqual(cancel.vague, [], 'vague phrases must be quotes from the email');
  } finally {
    restore();
  }
});

test('model failure falls back to the rule parser, which still splits the asks', async () => {
  const restore = mockModel(null, false);
  try {
    const r = await extractEmail(body, 'ABS East 2026 — Ford updates', ctx, { issuerId: 'ford' });
    assert.equal(r.parser, 'rules');
    assert.deepEqual(
      r.asks.map((a) => a.operation),
      ['reschedule', 'cancel'],
    );
    assert(r.asks.every((a) => a.uncertainties.some((u) => u.includes('AI model unavailable'))));
  } finally {
    restore();
  }
});
