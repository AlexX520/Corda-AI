import type { AppState } from '@/lib/types';
import type { Extraction } from '@/lib/extraction-schema';
type Action = AppState['actions'][number];
type Email = AppState['emails'][number];

/** Every action is one of these schedule changes (how bankers talk about them) or "other". */
export type KindId = 'escalation' | 'new' | 'reschedule' | 'availability' | 'cancel' | 'preference' | 'other';
export const kindOrder: KindId[] = [
  'escalation',
  'new',
  'reschedule',
  'availability',
  'cancel',
  'preference',
  'other',
];
export const kindLabel: Record<KindId, string> = {
  escalation: 'Escalation',
  new: 'New request',
  reschedule: 'Reschedule',
  availability: 'Availability',
  cancel: 'Cancel',
  preference: 'Preferences',
  other: 'Other',
};

/** The email ask behind an action (one action per ask). */
export function askOf(a: Action, data: AppState) {
  const email = data.emails.find((e) => e.id === a.emailId);
  const proposal =
    email?.proposals.find((p) => p.id === a.proposalId) ||
    (a.proposalId ? undefined : email?.proposals[0]);
  return { email, proposal, extraction: proposal?.extraction as unknown as Extraction | undefined };
}

export function actionKind(a: Action, data?: AppState): { id: KindId; label: string } {
  const t = a.type;
  const x = data ? askOf(a, data).extraction : undefined;
  if (/escalation/i.test(t)) return { id: 'escalation', label: 'Escalation' };
  if (/coverage preference/i.test(t)) return { id: 'preference', label: 'Preferences' };
  if (/inquiry/i.test(t) && x?.windows?.some((w) => w.kind === 'unavailable'))
    return { id: 'availability', label: 'Availability' };
  if (/reschedul/i.test(t)) return { id: 'reschedule', label: 'Reschedule' };
  if (/cancel/i.test(t)) return { id: 'cancel', label: 'Cancel' };
  if (/availability/i.test(t)) return { id: 'availability', label: 'Availability' };
  if (/resource/i.test(t)) return { id: 'other', label: 'Rooms' };
  if (/confirmation/i.test(t)) return { id: 'other', label: 'Confirmation' };
  if (/inquiry/i.test(t)) return { id: 'other', label: 'Question' };
  if (/request|alternative/i.test(t) || a.requestId) return { id: 'new', label: 'New request' };
  return { id: 'other', label: t };
}

/**
 * One definition of "open work" so the sidebar, page heading, filter chips and overview always
 * agree: open actions of this conference plus open actions not yet tied to any conference
 * ("Needs triage"), which appear once, in their own lane.
 */
export function openWork(data: AppState, conferenceId: string) {
  // Acknowledged escalations stay open for their owner only (not in everyone's urgent count).
  const open = data.actions.filter(
    (a) => a.status === 'Open' || (a.status === 'Acknowledged' && a.assignedTo === data.user.id),
  );
  const conference = open.filter((a) => a.conferenceId === conferenceId);
  const triage = open.filter((a) => !a.conferenceId);
  const acknowledged = conference.filter((a) => a.status === 'Acknowledged');
  return { conference, triage, acknowledged, total: conference.length + triage.length };
}

/** "Ask 2 of 3" when an email holds several asks. */
export function askPosition(a: Action, data: AppState) {
  const { email, proposal } = askOf(a, data);
  if (!email || !proposal || email.proposals.length < 2) return null;
  return `Ask ${proposal.askIndex + 1} of ${email.proposals.length}`;
}

export const emailIsTriage = (e: Email) => !e.conferenceId;
