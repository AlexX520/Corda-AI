import test from 'node:test';
import assert from 'node:assert/strict';
import { extractEmail, generateDraft } from '../src/lib/extraction';
import { llmPhrase } from '../src/lib/ask';
import { resetLlmState } from '../src/lib/llm';

const ctx = {
  conferences: [{ id: 'abs-east', name: 'ABS East 2026', startDate: '2026-10-19', endDate: '2026-10-21', timezone: 'America/New_York' }],
  issuers: [{ id: 'ford', name: 'Ford Credit' }],
  investors: [{ id: 'pimco', name: 'PIMCO' }],
};

/** A host that never answers: fetch only settles when aborted. */
function hangingHost() {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((_: unknown, init?: RequestInit) => {
    calls++;
    return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
  }) as typeof fetch;
  process.env.LLM_API_KEY = 'sk-test-not-real';
  process.env.LLM_TIMEOUT_MS = '300';
  resetLlmState();
  return {
    calls: () => calls,
    restore: () => {
      globalThis.fetch = original;
      delete process.env.LLM_API_KEY;
      delete process.env.LLM_TIMEOUT_MS;
      resetLlmState();
    },
  };
}

test('unreachable LLM: extraction, drafts and Ask Corda fall back quickly and never hang', async () => {
  const host = hangingHost();
  const keepAlive = setInterval(() => {}, 1000); // abort timers are unref'd
  try {
    const t0 = Date.now();
    const r = await extractEmail('Ford Credit / PIMCO: please cancel Monday 10am.', 'ABS East — Ford', ctx, { issuerId: 'ford' });
    assert.equal(r.parser, 'rules');
    assert.match(r.fallbackNote || '', /AI model unavailable/);
    assert(!/sk-/.test(JSON.stringify(r)), 'the key never appears in output');
    // Later calls skip the model during the cool-down instead of waiting again.
    const draft = await generateDraft('facts', 'template draft');
    const answer = await llmPhrase('q', { pattern: 'x', answer: ['a'], sources: [{ kind: 'meeting', id: 'm', label: 'm' }] });
    assert.equal(draft, 'template draft');
    assert.equal(answer.llm, undefined);
    assert(Date.now() - t0 < 2000, `fell back in ${Date.now() - t0} ms`);
    assert.equal(host.calls(), 1, 'one attempt, then cool-down');
  } finally {
    clearInterval(keepAlive);
    host.restore();
  }
});
