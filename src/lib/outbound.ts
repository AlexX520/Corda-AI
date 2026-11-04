/**
 * Client-safe outbound email. Drafts to issuers and investors carry a short human question about
 * the specific missing fact — never parser diagnostics — and are checked for recipients outside
 * the registered domains and for deal / MNPI terms before they are sent.
 */
import { formatInTimeZone } from 'date-fns-tz';
import type { Extraction } from './extraction-schema';

/** Simple keyword screen for deal / MNPI language. Case-insensitive; "project " needs a name after it. */
export const MNPI_KEYWORDS = [
  'project ',
  'acquisition',
  'merger',
  'not public',
  'not yet announced',
  'restricted list',
  'wall-cross',
  'wall cross',
  'over the wall',
  'under nda',
  'insider',
  'inside information',
  'confidential until launch',
  'pricing',
  'mnpi',
];
export function findSensitive(text: string) {
  const lower = text.toLowerCase();
  return MNPI_KEYWORDS.filter((k) =>
    k === 'project ' ? /\b[Pp]roject [A-Z][a-z]+/.test(text) : lower.includes(k),
  ).map((k) => k.trim());
}
/** Remove quoted lines ("> …") and quoted phrases that contain deal / MNPI terms. */
export function stripSensitiveQuotes(body: string) {
  let removed = 0;
  const lines = body.split('\n').filter((line) => {
    if (/^\s*>/.test(line) && findSensitive(line).length) {
      removed++;
      return false;
    }
    return true;
  });
  const text = lines.join('\n').replace(/“([^”]{1,300})”/g, (m, inner: string) => {
    if (!findSensitive(inner).length) return m;
    removed++;
    return '[quoted text removed]';
  });
  return { text, removed };
}

export const replySubject = (subject: string) =>
  /^\s*re:/i.test(subject) ? subject.trim() : `Re: ${subject.trim()}`;

type Labels = { issuer: string | null; investor: string | null; conference: string | null };
/**
 * One short question per missing fact. `perspective` is who we write to: an issuer is asked about
 * "the BlackRock meeting", an investor about "the Ford Credit meeting".
 */
export function clientQuestions(
  ask: Pick<Extraction, 'category' | 'missing' | 'vague' | 'referenceTime' | 'operation'>,
  labels: Labels,
  perspective: 'issuer' | 'investor' | 'other',
  zone = 'America/New_York',
  extra: 'meeting'[] = [],
) {
  const other =
    perspective === 'issuer'
      ? labels.investor
      : perspective === 'investor'
        ? labels.issuer
        : [labels.issuer, labels.investor].filter(Boolean).join(' / ');
  const meeting = other ? `the ${other} meeting` : 'the meeting';
  const verb =
    ask.category === 'Meeting Cancellation'
      ? 'cancel'
      : ask.category === 'Reschedule Request'
        ? 'move'
        : 'change';
  const zoneLabel =
    zone === 'America/New_York'
      ? 'ET'
      : zone === 'America/Los_Angeles'
        ? 'PT'
        : zone === 'America/Chicago'
          ? 'CT'
          : 'local time';
  const q: string[] = [];
  const missing = new Set([...ask.missing, ...extra]);
  if (missing.has('conference')) q.push('Could you confirm which event this is for?');
  if (missing.has('issuer')) q.push('Could you confirm which company this is for?');
  if (missing.has('investor')) q.push('Could you confirm which investor this is with?');
  if (missing.has('meeting'))
    q.push(
      ask.referenceTime
        ? `Could you confirm the current day and time of ${meeting} you'd like to ${verb}? We have it at a different time than ${formatInTimeZone(ask.referenceTime, zone, 'EEE h:mm a')}.`
        : `Could you confirm the current day and time of ${meeting} you'd like to ${verb}?`,
    );
  if (missing.has('time'))
    q.push(
      ask.category === 'Reschedule Request'
        ? `Could you confirm the time you'd like to move ${meeting} to?`
        : `Could you confirm the day and time you'd like for ${meeting}?`,
    );
  if (missing.has('exactTime'))
    for (const phrase of ask.vague.slice(0, 3))
      q.push(
        `Could you confirm the exact start and end times (${zoneLabel}) you mean by “${phrase.replace(/[.\s]+$/, '')}”?`,
      );
  if (missing.has('finalConsent')) q.push('Could you confirm this is final so we can lock it in?');
  if (!q.length)
    q.push(
      `Could you confirm the change you'd like us to make to ${meeting} so we can update the schedule?`,
    );
  return q;
}

export function clarificationBody(questions: string[], senderName: string) {
  const ask =
    questions.length === 1
      ? questions[0]
      : `Before we update the schedule, could you help with the following:\n${questions.map((q) => `- ${q}`).join('\n')}`;
  const { text } = stripSensitiveQuotes(
    `Hi,\n\nThanks for your note. ${ask}\n\nWe haven't changed anything on the schedule yet.\n\nBest regards,\n${senderName}`,
  );
  return text;
}

/** Recipients whose domain is neither a registered issuer/investor domain nor internal. */
export function outsideAllowlist(addresses: string[], allowedDomains: string[]) {
  const allowed = allowedDomains.map((d) => d.toLowerCase());
  return addresses.filter((a) => {
    const d = a.trim().toLowerCase().split('@').pop() || '';
    // Exact domains only: evil.onemain.example is not onemain.example.
    return !allowed.includes(d);
  });
}
