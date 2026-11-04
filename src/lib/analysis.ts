import { formatInTimeZone } from 'date-fns-tz';
import type { Context, Extraction, Hints } from './extraction-schema';
import { newEmailContent, namedContext, splitForward } from './rule-parser';
import {
  finalizeAsks,
  resolveConference,
  securityFlags,
  senderTrust,
  SUSPICIOUS_FLAG,
  type SenderTrust,
} from './email-trust';
import { findCandidates, isOpenMeeting, type MeetingLike, type Names } from './review-rules';

type Party = { id: string; name: string; contactEmail: string; ownerId?: string | null };
export type AnalyseInput = {
  sender: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  conferenceId?: string;
  issuerId?: string;
  receivedAt?: string;
};
export type AnalyseDeps = {
  conferences: Context['conferences'];
  issuers: Party[];
  investors: Party[];
  users: { id: string; email: string; role: string }[];
  meetings: MeetingLike[];
  internal: string[];
  today: string;
  /** Conferences where these companies already have meetings, requests or availability. */
  involvement: (issuerIds: string[], investorIds: string[]) => Promise<string[]> | string[];
  extract: (
    body: string,
    subject: string,
    ctx: Context,
    hints: Hints,
  ) =>
    | Promise<{ asks: Extraction[]; parser: 'llm' | 'rules'; whole?: boolean }>
    | { asks: Extraction[]; parser: 'llm' | 'rules'; whole?: boolean };
};
const namesFrom = (
  issuers: { id: string; name: string }[],
  investors: { id: string; name: string }[],
): Names => ({
  issuer: (id) => issuers.find((i) => i.id === id)?.name || 'Unassociated',
  investor: (id) => investors.find((i) => i.id === id)?.name || '—',
});
void formatInTimeZone;

/**
 * Read an email into reviewable asks: sender check (outer and forwarded From), event, parsing,
 * escalation flag, suspicious signals and meeting match. Pure apart from the injected
 * dependencies, so tests run the same logic as ingest.
 */
export async function analyse(p: AnalyseInput, deps: AnalyseDeps) {
  const { conferences, issuers, investors, users, meetings, involvement, extract } = deps;
  const ctx = { conferences, issuers, investors };
  const parties = { issuers, investors, internal: deps.internal };
  const outer = senderTrust(p.sender, parties);
  const names = namesFrom(issuers, investors);
  // Forwards: a colleague's short note on top of a client's message. The client's message is the
  // source; its From is verified too, and the colleague is kept as "forwarded by".
  const { note, forwarded } = splitForward(p.body);
  const inner = forwarded?.fromEmail ? senderTrust(forwarded.fromEmail, parties) : null;
  const forwardCue =
    /\b(?:see below|below|fyi|pls action|please action|can we do this|forwarding)\b/i.test(note) ||
    /^\s*(?:fw|fwd)\s*:/i.test(p.subject);
  const isForward = Boolean(
    forwarded &&
    inner &&
    inner.status !== 'internal' &&
    (outer.status === 'internal' || (note.length < 400 && forwardCue)),
  );
  const client = isForward ? inner! : outer;
  // The other registered parties on the email (to/cc) help when the text names nobody.
  const others = [...p.to, ...p.cc]
    .map((x) => senderTrust(x, parties))
    .filter((t) => t.status === 'verified');
  const one = (ids: (string | null)[]) => {
    const set = [...new Set(ids.filter(Boolean))];
    return set.length === 1 ? (set[0] as string) : null;
  };
  const partyIssuerId = one(others.map((t) => t.issuerId));
  const partyInvestorId = one(others.map((t) => t.investorId));
  const trusted = client.status !== 'unverified' && outer.status !== 'unverified';
  const read = async (body: string, who: SenderTrust) => {
    // Which event: named in the email, else the only event of the sender's company (or the
    // company the email names), else the only active event — and say that it was assumed.
    let defaultConferenceId: string | null = null,
      contextNote = '';
    const named = namedContext(body, p.subject, ctx);
    if (!p.conferenceId && !named.conferenceId) {
      const issuerIds = who.issuerId
        ? [who.issuerId]
        : who.investorId
          ? []
          : named.issuerIds.slice(0, 1);
      const investorIds = who.investorId
        ? [who.investorId]
        : who.issuerId || issuerIds.length
          ? []
          : named.investorIds.slice(0, 1);
      const resolved = resolveConference({
        conferences,
        involved: await involvement(issuerIds, investorIds),
        entityName: issuerIds.length
          ? names.issuer(issuerIds[0])
          : investorIds.length
            ? names.investor(investorIds[0])
            : null,
        today: deps.today,
      });
      defaultConferenceId = resolved.conferenceId;
      contextNote = resolved.note;
    }
    const ok = who.status !== 'unverified';
    const extracted = await extract(body, p.subject, ctx, {
      conferenceId: p.conferenceId,
      issuerId: p.issuerId,
      defaultConferenceId,
      senderIssuerId: ok ? who.issuerId : null,
      senderInvestorId: ok ? who.investorId : null,
      partyIssuerId: ok ? partyIssuerId : null,
      partyInvestorId: ok ? partyInvestorId : null,
      receivedAt: p.receivedAt || new Date().toISOString(),
    });
    return { ...extracted, defaultConferenceId, contextNote };
  };
  let result = await read(p.body, client);
  let content = newEmailContent(p.body);
  if (isForward && forwarded) {
    // Read the forwarded message and keep the colleague's note only where it adds something
    // concrete; the same ask in both is kept once (the one with a time wins).
    const fwd = await read(forwarded.body, inner!);
    const concrete = (a: Extraction) =>
      a.windows.length > 0 || Boolean(a.referenceTime) || Boolean(a.issuerId && a.investorId);
    const noteAsks = result.whole ? [] : result.asks.filter(concrete);
    const merged: Extraction[] = [];
    for (const a of [...noteAsks, ...(fwd.whole && noteAsks.length ? [] : fwd.asks)]) {
      const same = merged.findIndex(
        (m) =>
          m.category === a.category && m.issuerId === a.issuerId && m.investorId === a.investorId,
      );
      const score = (x: Extraction) => x.windows.length * 2 + Number(Boolean(x.referenceTime));
      if (same < 0) merged.push(a);
      else if (score(a) > score(merged[same])) merged[same] = a;
    }
    result = {
      ...fwd,
      asks: merged.length ? merged : fwd.asks,
      whole: !noteAsks.length && fwd.whole,
      contextNote: fwd.contextNote || result.contextNote,
    };
    content = `${newEmailContent(note)}\n\n${newEmailContent(forwarded.body)}`;
  }
  const { defaultConferenceId, contextNote } = result;
  for (const e of result.asks)
    if (
      (e.conferenceId && !conferences.some((c) => c.id === e.conferenceId)) ||
      (e.issuerId && !issuers.some((i) => i.id === e.issuerId)) ||
      (e.investorId && !investors.some((i) => i.id === e.investorId))
    )
      throw new Error('Unknown extracted association.');
  const zoneOf = (id: string | null) =>
    conferences.find((c) => c.id === id)?.timezone || 'America/New_York';
  const effective: SenderTrust =
    outer.status === 'unverified'
      ? outer
      : isForward && inner!.status === 'unverified'
        ? inner!
        : outer;
  const final = finalizeAsks(result.asks, {
    subject: p.subject,
    content,
    trust: effective.status === 'unverified' ? effective : client,
    names,
    zone: zoneOf(result.asks[0]?.conferenceId || defaultConferenceId),
    whole: result.whole,
  });
  const asks = final.asks;
  const flags = securityFlags(p.subject, p.body);
  if (outer.status === 'unverified')
    flags.unshift(
      outer.lookalikeOf
        ? `Sender not verified: ${outer.domain} looks like ${outer.lookalikeOf} but is not the registered domain.`
        : `Sender not verified: ${outer.domain} is not a registered issuer, investor or bank domain.`,
    );
  if (isForward && inner!.status === 'unverified')
    flags.unshift(
      `Forwarded message is from an unverified sender: ${inner!.domain}${inner!.lookalikeOf ? ` looks like ${inner!.lookalikeOf}` : ' is not a registered domain'}.`,
    );
  const suspicious = !trusted || flags.some((f) => SUSPICIOUS_FLAG.test(f));
  // Suggest the affected meeting only when the rules allow it (see findCandidates).
  for (const e of asks) {
    if (!['cancel', 'reschedule', 'update'].includes(e.operation)) continue;
    const r = findCandidates(e, meetings, {
      zone: zoneOf(e.conferenceId),
      trusted: !suspicious,
      open: isOpenMeeting,
      n: names,
    });
    e.meetingId = r.preselectId;
    if (!r.preselectId && !suspicious && e.issuerId && !e.missing.includes('meeting'))
      e.missing.push('meeting');
  }
  // "Moved a third time and we walk": protect that meeting.
  let protectMeetingId: string | null = null;
  if (final.threat) {
    const esc = asks.find((a) => a.category === 'Escalation / complaint');
    const pool = meetings.filter(
      (m) => m.issuerId === esc?.issuerId && (!esc?.investorId || m.investorId === esc.investorId),
    );
    if (esc?.investorId && pool.length === 1) protectMeetingId = pool[0].id;
  }
  const addressed = users.find(
    (u) => u.role === 'BANKER' && p.to.some((t) => t.toLowerCase() === u.email.toLowerCase()),
  );
  return {
    asks,
    trust: effective,
    flags,
    contextNote,
    content,
    issuers,
    addressed,
    parser: result.parser,
    suspicious,
    escalation: final.escalation,
    escalationReasons: final.reasons,
    protectMeetingId,
    threat: final.threat,
    originalSender: isForward ? forwarded!.fromEmail : null,
    originalSenderName: isForward ? forwarded!.fromName : null,
    forwardedBy: isForward ? p.sender : null,
  };
}
export type Analysis = Awaited<ReturnType<typeof analyse>>;
