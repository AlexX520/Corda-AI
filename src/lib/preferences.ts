import { z } from 'zod';
import { llmChat } from './llm';

/**
 * Coverage preferences sent by email (Alex: "each banker emails the conference mailbox which
 * meetings they must attend and which they want to prioritise; the AI reads it and allocation
 * uses it"). The model reads the email when it is available; a rule reader is the fallback.
 * Every preference keeps the sentence it came from, and nothing is saved until the coordinator
 * approves it.
 */
export const PREF_LEVELS = ['Must Attend', 'High Priority', 'Medium Priority', 'Low Priority', 'Cannot Attend'] as const;
export type PrefLevel = (typeof PREF_LEVELS)[number];
export type EmailPreference = { issuerId: string; level: PrefLevel; evidence: string };
type Issuer = { id: string; name: string };

const CUES =
  /\b(?:prefer(?:ence)?s?|must (?:attend|be in|cover|have)|need to (?:be in|cover|attend)|prioriti[sz]e|priority|would (?:like|love) to (?:cover|be in|attend|take)|keen (?:on|to)|i(?:'| a)?ll take|can(?:'|no)?t (?:make|cover|attend|do)|cannot (?:make|cover|attend)|not available for|skip|nice to have|if (?:possible|there'?s room)|happy to cover|put me (?:on|in|down for))\b/i;

/** Short names bankers use: "Ford" for Ford Credit, "GM" for GM Financial. */
function aliases(name: string) {
  const out = new Set([name.toLowerCase()]);
  const first = name.split(/\s+/)[0];
  if (first.length >= 3 || /^[A-Z]{2,}$/.test(first)) out.add(first.toLowerCase());
  return [...out];
}

function levelOf(clause: string): PrefLevel | null {
  const t = clause.toLowerCase();
  if (/\b(?:can(?:'|no)?t|cannot|won'?t|not available|unavailable|skip|no(?:t)? (?:for|on) me|conflict)\b/.test(t)) return 'Cannot Attend';
  if (/\b(?:must|need to|have to|has to|required|mandatory|definitely|non-?negotiable)\b/.test(t)) return 'Must Attend';
  if (/\b(?:prioriti[sz]e|priority|high|really (?:want|like)|would love|keen|top|first choice)\b/.test(t)) return 'High Priority';
  if (/\b(?:low|only if|last|if nobody else|backup)\b/.test(t)) return 'Low Priority';
  if (/\b(?:nice to have|if possible|if there'?s room|happy to|would like|could|medium|open to|i'?ll take|put me)\b/.test(t)) return 'Medium Priority';
  return null;
}

/** Rule reader: one clause per issuer named, level from the words in that clause. */
export function readPreferencesByRules(body: string, issuers: Issuer[]): EmailPreference[] {
  const text = body.split(/\n\s*(?:>|-{2,}|on .+ wrote:|from:)/i)[0];
  const sentences = text.split(/(?<=[.!?;])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  const out: EmailPreference[] = [];
  const add = (ids: Issuer[], level: PrefLevel, evidence: string) => {
    for (const i of ids) if (!out.some((o) => o.issuerId === i.id)) out.push({ issuerId: i.id, level, evidence: evidence.slice(0, 200) });
  };
  let heading: PrefLevel | null = null; // "Must attend:" on its own line applies to the list below
  for (const sentence of sentences) {
    // "I must attend Ford, and please prioritise Ally" → two clauses; "Ford, Ally and GM: must" stays one list.
    const clauses = sentence
      .split(/,?\s+(?:and|but|also)\s+(?=(?:please|pls|i\b|i'|also|then|for|put|could|can)\b)|,\s*(?=(?:please|pls|i\b|i'|also|then|but)\b)|\)?\s+and\s+(?=[A-Z][a-z])/i)
      .map((x) => x.trim())
      .filter(Boolean);
    let pending: Issuer[] = [];
    for (const clause of clauses) {
      const lower = ` ${clause.toLowerCase()} `;
      const named = issuers.filter((i) =>
        aliases(i.name).some((a) => new RegExp(`[^a-z]${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^a-z]`).test(lower)),
      );
      const level = levelOf(clause);
      if (named.length && level) add([...pending, ...named], level, clause);
      else if (named.length && heading) add(named, heading, clause);
      else if (named.length) pending.push(...named);
      else if (level && pending.length) add(pending, level, `${sentence}`);
      else if (level) heading = level;
      if (level && named.length) pending = [];
    }
  }
  return out;
}

export function looksLikePreferences(subject: string, body: string) {
  return /\b(?:preferences?|coverage|cover)\b/i.test(subject) || CUES.test(body);
}

const llmAnswer = z.object({
  preferences: z.array(z.object({ issuer: z.string(), level: z.enum(PREF_LEVELS), evidence: z.string() })),
});

/** Model reader; returns null when the model is not configured or its answer cannot be used. */
export async function readPreferencesByModel(body: string, issuers: Issuer[]): Promise<EmailPreference[] | null> {
  if (!process.env.LLM_API_KEY) return null;
  try {
    const data = await llmChat({
      messages: [
        {
          role: 'system',
          content:
            'A banker emails the conference mailbox with which issuer meetings they want to cover. Return JSON {"preferences":[{"issuer","level","evidence"}]}. ' +
            `level is one of ${PREF_LEVELS.join(', ')}. issuer must be one of: ${issuers.map((i) => i.name).join('; ')}. ` +
            'evidence is the exact words from the email. Only include issuers the email names. No other text.',
        },
        { role: 'user', content: body.slice(0, 6000) },
      ],
      response_format: { type: 'json_object' },
    });
    const parsed = llmAnswer.safeParse(JSON.parse(String(data.choices?.[0]?.message?.content || '{}')));
    if (!parsed.success) return null;
    const out: EmailPreference[] = [];
    for (const p of parsed.data.preferences) {
      const issuer = issuers.find((i) => i.name.toLowerCase() === p.issuer.toLowerCase()) || issuers.find((i) => aliases(i.name).includes(p.issuer.toLowerCase()));
      // Evidence must come from the email, like every other AI answer in Corda.
      if (issuer && body.toLowerCase().includes(p.evidence.toLowerCase().slice(0, 40)) && !out.some((o) => o.issuerId === issuer.id))
        out.push({ issuerId: issuer.id, level: p.level, evidence: p.evidence.slice(0, 200) });
    }
    return out;
  } catch {
    return null;
  }
}

export async function readPreferences(body: string, issuers: Issuer[]) {
  const model = await readPreferencesByModel(body, issuers);
  if (model && model.length) return { preferences: model, parser: 'llm' as const };
  return { preferences: readPreferencesByRules(body, issuers), parser: 'rules' as const };
}

export const prefWeight = (level: PrefLevel) =>
  level === 'Must Attend' ? 120 : level === 'High Priority' ? 80 : level === 'Medium Priority' ? 45 : level === 'Low Priority' ? 20 : 0;
