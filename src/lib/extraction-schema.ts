import { z } from 'zod';
export const categories = [
  'Issuer Availability Update',
  'New Meeting Request',
  'Meeting Confirmation',
  'Reschedule Request',
  'Meeting Cancellation',
  'Escalation / complaint',
  'General Conference Inquiry',
  'Unrelated Email',
] as const;
export const operations = [
  'add',
  'replace',
  'remove',
  'confirm',
  'reschedule',
  'cancel',
  'escalate',
  'inquiry',
] as const;
/** Facts the email leaves open. Used to write a short, specific question back to the client. */
export const missingFacts = [
  'conference',
  'issuer',
  'investor',
  'meeting',
  'time',
  'exactTime',
  'finalConsent',
] as const;
export type MissingFact = (typeof missingFacts)[number];
export const windowSchema = z.object({
  start: z.string().datetime(),
  end: z.string().datetime(),
  kind: z.enum(['availability', 'existingMeeting', 'unavailable']),
  evidence: z.string().min(1),
  /** "manual" = typed in by the reviewer, not quoted from the email. */
  source: z.enum(['email', 'manual']).default('email'),
});
/** One ask = one schedule operation. An email can contain several. */
export const extractionSchema = z.object({
  category: z.enum(categories),
  conferenceId: z.string().nullable(),
  issuerId: z.string().nullable(),
  investorId: z.string().nullable(),
  operation: z.enum(operations),
  tentative: z.boolean(),
  windows: z.array(windowSchema),
  uncertainties: z.array(z.string()),
  evidence: z.array(z.string()),
  needsReview: z.boolean(),
  meetingId: z.string().nullable().default(null),
  /** Plain-language one-liner, e.g. "Move BlackRock to Tue 2:00 PM". */
  summary: z.string().max(400).default(''),
  /** Time of the existing meeting the ask refers to ("cancel PIMCO Tue 1pm"). */
  referenceTime: z.string().datetime().nullable().default(null),
  attendees: z.number().int().min(1).max(500).nullable().default(null),
  durationMinutes: z.number().int().min(5).max(480).nullable().default(null),
  missing: z.array(z.enum(missingFacts)).default([]),
  /** Exact phrases from the email that name a time without an exact window. */
  vague: z.array(z.string()).default([]),
});
export type Extraction = z.infer<typeof extractionSchema>;
export type ExtractionWindow = Extraction['windows'][number];
export const extractionResultSchema = z.object({ asks: z.array(extractionSchema).min(1).max(12) });
export type ExtractionResult = z.infer<typeof extractionResultSchema>;
export type Context = {
  conferences: { id: string; name: string; startDate: string; endDate: string; timezone: string }[];
  issuers: { id: string; name: string }[];
  investors: { id: string; name: string }[];
};
/**
 * Hints known before reading the text. `conferenceId`/`issuerId` come from the mailbox (they
 * override the text); the rest are fallbacks used only when the email itself names nothing.
 */
export type Hints = {
  conferenceId?: string;
  issuerId?: string;
  defaultConferenceId?: string | null;
  senderIssuerId?: string | null;
  senderInvestorId?: string | null;
  receivedAt?: string;
};
