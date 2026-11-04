/**
 * Who sent an email, what it might be trying to do, and which event it belongs to. Pure functions
 * so they can be unit-tested; the service feeds them data from the database.
 */
import { askSummary, type Names } from './review-rules';
import { extractionSchema, type Extraction } from './extraction-schema';
import { findSensitive } from './outbound';

export const domainOf = (address: string) => address.trim().toLowerCase().split('@').pop() || '';

/** Internal bank domains (comma-separated INTERNAL_DOMAINS), default the demo users' domain. */
export function internalDomains(raw = process.env.INTERNAL_DOMAINS) {
  const list = (raw || 'conferenceos.demo')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
  return list.length ? list : ['conferenceos.demo'];
}

type Party = { id: string; name: string; contactEmail: string };
export type SenderTrust = {
  status: 'internal' | 'verified' | 'unverified';
  domain: string;
  issuerId: string | null;
  investorId: string | null;
  /** Registered domain this one imitates, e.g. bayview.example for bayview-ir-secure.example. */
  lookalikeOf: string | null;
};

/** Exact domain match. A subdomain (evil.onemain.example) is not the registered domain. */
const sameOrSub = (domain: string, registered: string) => domain === registered;
const label = (domain: string) => domain.split('.')[0];
function distance(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return d[a.length][b.length];
}

/** Compare the sender's domain with registered issuer/investor contacts and the bank's own domains. */
export function senderTrust(
  sender: string,
  parties: { issuers: Party[]; investors: Party[]; internal: string[] },
): SenderTrust {
  const domain = domainOf(sender);
  const base = { domain, issuerId: null, investorId: null, lookalikeOf: null };
  if (parties.internal.some((d) => sameOrSub(domain, d))) return { ...base, status: 'internal' };
  const issuer = parties.issuers.find((i) => sameOrSub(domain, domainOf(i.contactEmail)));
  const investor = parties.investors.find((i) => sameOrSub(domain, domainOf(i.contactEmail)));
  // A domain shared by an issuer and its investing arm is read as the issuer.
  if (issuer || investor)
    return {
      ...base,
      status: 'verified',
      issuerId: issuer?.id || null,
      investorId: issuer ? null : investor!.id,
    };
  const registered = [
    ...new Set([...parties.issuers, ...parties.investors].map((p) => domainOf(p.contactEmail))),
    ...parties.internal,
  ];
  const tokens = domain.split(/[.-]/).filter((t) => t.length >= 3);
  // Punycode (xn--) labels imitate a name with look-alike characters; compare their ASCII part.
  const ascii = label(domain).replace(/^xn--/, '').replace(/-[a-z0-9]{2,4}$/, '');
  const near = (a: string, b: string) => {
    const d = distance(a, b);
    return d > 0 && (b.length >= 5 ? d <= 2 : d <= 1);
  };
  const lookalikeOf =
    registered.find(
      (r) =>
        tokens.includes(label(r)) ||
        near(label(domain), label(r)) ||
        (domain.includes('xn--') && near(ascii, label(r))),
    ) || (domain.includes('xn--') ? 'an internationalized (punycode) domain' : null);
  return { ...base, status: 'unverified', lookalikeOf };
}

/** Warnings shown on the email: links, credential requests, possible MNPI and embedded instructions. */
export function securityFlags(subject: string, body: string) {
  const text = `${subject}\n${body}`;
  const flags: string[] = [];
  const hosts = [
    ...text.matchAll(/\bhttps?:\/\/([^\s/?#)>\]]+)|\bwww\.([^\s/?#)>\]]+)/gi),
  ].map((m) => (m[1] || `www.${m[2]}`).toLowerCase());
  if (hosts.length)
    flags.push(
      `Contains a link (${[...new Set(hosts)].slice(0, 3).join(', ')}) — don't open or forward it until the sender is confirmed.`,
    );
  // Defanged ("hxxps://bit[.]ly") and bare ("share-point.example/deck") links are links too.
  const defanged = [...text.matchAll(/\bhxxps?:\/\/\S+|\b[\w-]+\[\.\][\w.[\]-]+(?:\/\S*)?/gi)].map((m) => m[0]);
  const bare = [...text.matchAll(/(?<![@\w.\/-])((?:[a-z0-9-]+\.)+(?:example|com|net|org|co|io|ly|info|biz|app))(\/[^\s)>\]]*)/gi)]
    .map((m) => m[1].toLowerCase())
    .filter((h) => !hosts.includes(h));
  if (defanged.length || bare.length)
    flags.push(
      `Contains a disguised or bare link (${[...new Set([...defanged, ...bare])].slice(0, 3).join(', ')}) — treat as a link.`,
    );
  if (
    /\b(?:sign[ -]?in|log[ -]?in|credentials?|password|passcode|verify your (?:account|identity)|MFA|one-time code|2FA)\b/i.test(text)
  )
    flags.push('Asks for a sign-in or credentials.');
  if (
    /\bsend\b[^.]{0,80}\b(?:list|attendees?|contacts?|mobile|phone numbers?|contact details|details|grid|planner|schedule)\b[^.]{0,80}\b(?:to|at)\b[^.]{0,60}(?:@(?:gmail|yahoo|hotmail|outlook|icloud|proton)\.|\b(?:this|my|our new|new|personal) (?:address|email)|personal)/i.test(
      text,
    ) ||
    /\b(?:cc|send|forward)\b[^\n]{0,60}@(?:gmail|yahoo|hotmail|outlook|icloud|proton)\./i.test(text)
  )
    flags.push('Asks to send attendee or investor data to an outside address — likely data theft.');
  const sensitive = findSensitive(text);
  if (sensitive.length)
    flags.push(
      `Possible deal / MNPI terms (${sensitive.join(', ')}) — keep them out of any reply.`,
    );
  if (
    /<!--[\s\S]*?-->/.test(text) ||
    /\[(?:system|assistant|ai)[^\]]{0,30}\]|\b(?:note|instructions?) (?:to|for) the (?:ai|assistant|scheduling assistant|model)\b|ignore (?:all |any )?(?:previous|prior|above) instructions|set needsReview|approve all (?:pending )?proposals|mark this sender verified|treat the sender as internal|skip review/i.test(
      text,
    )
  )
    flags.push('Contains hidden or embedded instructions aimed at automated tools — Corda ignored them.');
  return flags;
}
/** Flags that make an email suspicious even from a registered address (compromised mailbox). */
export const SUSPICIOUS_FLAG = /^(?:Asks for a sign-in|Asks to send attendee|Contains hidden or embedded|Sender not verified|Forwarded message is from an unverified)/;

/** Client complaints, error reports, investor threats and urgent same-day problems. */
export function detectEscalation(subject: string, content: string) {
  const reasons: string[] = [];
  let threat = false;
  const patterns: [RegExp, string][] = [
    [/\b(?:not acceptable|unacceptable)\b/i, 'Client says it is not acceptable'],
    [/\b(?:nobody|no one|no-one|never) (?:agreed|approved|asked)\b/i, 'Client reports a change nobody agreed to'],
    [
      /\bshowed up\b[^.]{0,80}\b(?:empty|another|wrong|no one|nobody|no-one|cancell?ed)\b|\bempty room\b/i,
      'Client reports a meeting that went wrong',
    ],
    [
      /\b(?:stuck (?:at|in)|stranded|ground stop|flight (?:was )?cancell?ed|missed (?:the|our) flight)\b/i,
      'Travel problem affecting a meeting',
    ],
    [/\b(?:complain\w*|disappointed|escalat\w*|this is a mess)\b/i, 'Client complaint'],
    [/\bdo not send any more\b|\bstop sending\b/i, 'Client asks us to stop sending changes'],
  ];
  for (const [re, reason] of patterns) if (re.test(content)) reasons.push(reason);
  if (
    /\b(?:we'?ll|we will|we'?d|will) (?:pass|walk|drop (?:it|the meeting)|pull out)\b|\braise it with\b[^.]{0,40}\bmanagement\b|\b(?:third|3rd) time\b/i.test(
      content,
    )
  ) {
    reasons.push('Investor threatens to drop the meeting if it moves again');
    threat = true;
  }
  // "asap" alone is not urgent; urgency needs a same-day signal.
  const urgent = /\burgent\b/i.test(`${subject}\n${content}`);
  const sameDay = /\b(?:today|this morning|this afternoon|tonight|right now|immediately)\b/i.test(`${subject}\n${content}`);
  if (urgent && sameDay) reasons.push('Urgent same-day request');
  return { reasons: [...new Set(reasons)], threat };
}

/**
 * Rules applied after any parser. An escalation is a flag on the email: it adds an "Escalation"
 * item that a person acknowledges and owns, and the email's real asks are still extracted (marked
 * "from an escalation"). Summaries are rebuilt from the final fields.
 */
export function finalizeAsks(
  asks: Extraction[],
  opts: {
    subject: string;
    content: string;
    trust: SenderTrust;
    names: Names;
    zone?: string;
    /** The parser found no sentence that asks for anything and read the email as one item. */
    whole?: boolean;
  },
) {
  const { reasons, threat } =
    opts.trust.status === 'unverified' ? { reasons: [], threat: false } : detectEscalation(opts.subject, opts.content);
  const llmEscalation = asks.find((a) => a.category === 'Escalation / complaint');
  let out = asks.filter((a) => a.category !== 'Escalation / complaint');
  const escalation = Boolean(reasons.length || llmEscalation);
  if (escalation) {
    const base = llmEscalation || asks[0];
    const issuerId = asks.map((a) => a.issuerId).find(Boolean) || opts.trust.issuerId;
    const investors = [...new Set(asks.map((a) => a.investorId).filter(Boolean))];
    const flag = extractionSchema.parse({
      ...base,
      category: 'Escalation / complaint',
      operation: 'escalate',
      issuerId,
      investorId: investors.length === 1 ? investors[0] : opts.trust.investorId,
      windows: [],
      meetingId: null,
      referenceTime: null,
      tentative: false,
      needsReview: true,
      conditional: false,
      condition: '',
      uncertainties: reasons.length ? reasons : ['Client escalation'],
      evidence: [...new Set(asks.flatMap((a) => a.evidence))].slice(0, 4),
      missing: [],
      vague: [],
    });
    // A whole-email reading of a complaint is not a real ask; drop it.
    out = (opts.whole ? [] : out).map((a) => ({ ...a, fromEscalation: true }));
    out.unshift(flag);
  }
  for (const a of out) a.summary = askSummary(a, opts.names, opts.zone);
  return { asks: out, escalation, reasons, threat };
}

/**
 * Which event an email belongs to when it names none: the only event its sender (or the company
 * it names) is on, else the only active or upcoming event overall, else ask.
 */
export function resolveConference(opts: {
  conferences: { id: string; name: string; endDate: string }[];
  /** Conferences where the email's company already has meetings, requests or availability. */
  involved: string[];
  entityName: string | null;
  today: string;
}): { conferenceId: string | null; note: string } {
  const involved = [...new Set(opts.involved)];
  if (involved.length === 1) {
    const c = opts.conferences.find((x) => x.id === involved[0])!;
    return {
      conferenceId: c.id,
      note: `Assumed ${c.name} — the only event with ${opts.entityName || 'this company'} on the schedule.`,
    };
  }
  const pool = involved.length
    ? opts.conferences.filter((c) => involved.includes(c.id))
    : opts.conferences;
  const active = pool.filter((c) => c.endDate >= opts.today);
  if (active.length === 1)
    return {
      conferenceId: active[0].id,
      note: `Assumed ${active[0].name} (only active conference).`,
    };
  return { conferenceId: null, note: 'Which event? The email does not name a conference.' };
}
