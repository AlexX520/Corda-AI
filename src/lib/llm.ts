/**
 * The one way Corda calls the configured LLM. It must never hang a request: every call has a
 * short timeout, and after a network failure the model is skipped for a cool-down period so a
 * batch of emails falls straight back to the rule parser. Errors never include provider text
 * (which can echo part of the API key).
 */
let downUntil = 0;

export const llmConfigured = () => Boolean(process.env.LLM_API_KEY);
export const llmTimeoutMs = () => Math.max(500, Number(process.env.LLM_TIMEOUT_MS) || 8000);
const COOL_DOWN_MS = 60_000;

export class LlmUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'LlmUnavailable';
  }
}

/** POST /chat/completions; returns the parsed JSON body or throws LlmUnavailable. */
export async function llmChat(payload: Record<string, unknown>, timeoutMs = llmTimeoutMs()): Promise<{ choices?: { message?: { content?: string } }[] }> {
  if (!llmConfigured()) throw new LlmUnavailable('not configured');
  if (Date.now() < downUntil) throw new LlmUnavailable('unreachable');
  let response: Response;
  try {
    response = await fetch(`${process.env.LLM_BASE_URL || 'https://api.openai.com/v1'}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LLM_API_KEY}` },
      body: JSON.stringify({ model: process.env.LLM_MODEL || 'gpt-4.1-mini', ...payload }),
    });
  } catch (e) {
    downUntil = Date.now() + COOL_DOWN_MS;
    throw new LlmUnavailable(e instanceof Error && /timeout|abort/i.test(`${e.name} ${e.message}`) ? 'timed out' : 'unreachable');
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403 || response.status >= 500) downUntil = Date.now() + COOL_DOWN_MS;
    throw new LlmUnavailable(`HTTP ${response.status}`);
  }
  return response.json();
}

/** Test hook. */
export function resetLlmState() {
  downUntil = 0;
}
