/** The OpenAI-compatible path must accept the multi-ask format (model answer mocked). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractEmail } from '../src/lib/extraction';
import { resetLlmState } from '../src/lib/llm';

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
  resetLlmState();
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
    assert(r.fallbackNote?.includes('AI model unavailable'));
    assert(r.asks.every((a) => !a.uncertainties.some((u) => /sk-|api key/i.test(u))));
  } finally {
    restore();
  }
});

test('an answer with no asks (out-of-office) is read as unrelated, not a fallback', async () => {
  const restore = mockModel({ asks: [] });
  try {
    const r = await extractEmail('I am out of the office with limited access to email.', 'Automatic reply', ctx);
    assert.equal(r.parser, 'llm');
    assert.equal(r.asks.length, 1);
    assert.equal(r.asks[0].category, 'Unrelated Email');
  } finally {
    restore();
  }
});

test('one unusable ask is dropped and the good ones are kept; paraphrased enums are mapped', async () => {
  const restore = mockModel({
    asks: [
      { category: 'Reschedule', operation: 'move', conferenceId: 'abs-east', issuerId: 'ford', investorId: 'blackrock', tentative: false, windows: [{ date: '2026-10-20', startTime: '14:00', endTime: '14:30', kind: 'availability', evidence: 'BlackRock - can we move that to Tuesday 2:00pm ET?' }], uncertainties: [], evidence: ['BlackRock - can we move that to Tuesday 2:00pm ET?'], needsReview: true, meetingId: null, summary: 'Move BlackRock' },
      { category: 'Meeting Cancellation', operation: 'cancel', conferenceId: 'abs-east', issuerId: 'ford', investorId: 'pimco', tentative: false, windows: [], uncertainties: [], evidence: ['Something the email never said at all, invented by the model'], needsReview: true, meetingId: null, summary: 'Cancel PIMCO' },
    ],
  });
  try {
    const r = await extractEmail(body, 'Ford updates', ctx);
    assert.equal(r.parser, 'llm');
    assert.equal(r.asks.length, 1);
    assert.equal(r.asks[0].category, 'Reschedule Request');
    assert.equal(r.asks[0].operation, 'reschedule');
    assert.match(r.readNote || '', /1 ask\(s\) dropped/);
  } finally {
    restore();
  }
});

test('the model is told the received date, so "tomorrow" resolves from it', async () => {
  const original = globalThis.fetch;
  let sent = '';
  globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
    sent = String(init?.body || '');
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ asks: [] }) } }] }), { status: 200 });
  }) as typeof fetch;
  process.env.LLM_API_KEY = 'test';
  resetLlmState();
  try {
    await extractEmail('Can we do tomorrow at 11?', 'Tomorrow', ctx, { receivedAt: '2026-10-19T15:00:00Z' });
    assert.match(sent, /received Monday 2026-10-19 11:00/);
  } finally {
    globalThis.fetch = original;
    delete process.env.LLM_API_KEY;
  }
});

test('"tomorrow" and unconverted time zones are corrected by code after the model', async () => {
  const { fixRelativeDays, fixUnconvertedZones } = await import('../src/lib/extraction');
  const base = { category: 'New Meeting Request', conferenceId: 'abs-east', issuerId: 'ford', investorId: 'blackrock', operation: 'add', tentative: false, uncertainties: [] as string[], needsReview: true, meetingId: null, summary: '', referenceTime: null, attendees: null, durationMinutes: null, missing: [], vague: [], conditional: false, condition: '', fromEscalation: false, flexible: false };
  // Received Sat Oct 17 evening ET; the model put "tomorrow 11:00" on Saturday.
  const a = { ...base, evidence: ['Jen can do tomorrow 11:00-11:30am ET'], windows: [{ start: '2026-10-17T15:00:00.000Z', end: '2026-10-17T15:30:00.000Z', kind: 'availability' as const, evidence: 'Jen can do tomorrow 11:00-11:30am ET', source: 'email' as const }] };
  fixRelativeDays(a as never, 'America/New_York', '2026-10-18T00:40:00Z');
  assert.equal(a.windows[0].start, '2026-10-18T15:00:00.000Z', 'moved to Sunday, same local time');
  // "2:00pm CT" kept as 2:00 PM event time by the model -> 3:00 PM ET.
  const b = { ...base, evidence: ['can we do 2:00pm CT instead of the 3pm slot?'], windows: [{ start: '2026-10-18T18:00:00.000Z', end: '2026-10-18T18:30:00.000Z', kind: 'availability' as const, evidence: 'can we do 2:00pm CT instead of the 3pm slot?', source: 'email' as const }] };
  fixUnconvertedZones(b as never, 'America/New_York');
  assert.equal(b.windows[0].start, '2026-10-18T19:00:00.000Z');
  // Already converted (3:00 PM ET) stays.
  const c = { ...base, evidence: ['can we do 2:00pm CT instead of the 3pm slot?'], windows: [{ start: '2026-10-18T19:00:00.000Z', end: '2026-10-18T19:30:00.000Z', kind: 'availability' as const, evidence: 'can we do 2:00pm CT instead of the 3pm slot?', source: 'email' as const }] };
  fixUnconvertedZones(c as never, 'America/New_York');
  assert.equal(c.windows[0].start, '2026-10-18T19:00:00.000Z');
});
