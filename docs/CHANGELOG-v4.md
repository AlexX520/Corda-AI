# Corda AI v4 — changelog

## Phase 1 — Reliability

Goal: nothing changes on a schedule unless a person approved exactly that change, and the AI never
guesses which meeting, which event or who an email is from.

### Database (migration `20261103120000_v4_reliability`, additive)

- `Proposal`: one row per **ask**. The unique index on `emailId` is replaced by
  `@@unique([emailId, askIndex])`; new `askIndex` (default 0, so existing rows are ask 0) and
  `summary`. `Email.proposal` became `Email.proposals`.
- `Email`: `senderStatus` (internal / verified / unverified), `securityFlags`, `contextNote`.
- `Action`: `proposalId` (backfilled from `emailId`), `meetingId` (backfilled for old
  availability-conflict actions), `ccUserIds`.
- `MeetingRequest`: `sourceEmailId`, `attendees`.
- `User.sessionVersion` (sign-out invalidates every earlier token).

### What changed, per item

1. **Multi-ask emails.** Extraction returns `{ asks: Extraction[] }` (rule parser and LLM prompt).
   The rule parser splits numbered/bulleted items, else sentences and `;` clauses that each carry
   their own operation verb; follow-on sentences without a verb join the previous ask; "still on" /
   "unchanged" lines are not asks; "cancel ALL our Tuesday meetings (Rocket 10am, Ford 1pm)" becomes
   one ask per issuer. It also reads explicit dates ("Wednesday Oct 21"), single times, time zones
   (ET/CT/PT/UK, duplicate "(7:30pm UK)" ignored), open-ended blocks ("nothing before 1pm"),
   durations and attendee counts. Ingest creates one Proposal + one Action per ask. The email is
   done only when every ask is approved / rejected / acknowledged. The review drawer shows
   "Ask 2 of 3" with a checklist; the queue and overview tag each item with its ask.
2. **Safe approve.**
   - A meeting/request is pre-selected only if issuer matches, investor matches whenever the email
     names one, it is the only candidate, the time the email mentions agrees, and the sender is
     verified. The drawer says why a candidate was (or was not) suggested.
   - "move / push / shift / instead of … to …" is a reschedule even if "cancel" appears elsewhere.
   - New category **Escalation / complaint** (not acceptable, nobody agreed, showed up to the wrong
     room, URGENT + same day, stuck at the airport…): one ask, priority Urgent, routed to the banker
     the email was addressed to and cc the issuer owner. No Approve button — **Acknowledge &
     assign** (owner + internal note); the follow-up stays open until marked resolved.
   - **Sender verification** against registered issuer/investor contact domains and
     `INTERNAL_DOMAINS` (default `conferenceos.demo`). Unknown or lookalike domains get a red
     "Sender not verified" banner, no pre-selection, and approval needs a typed reason (enforced on
     the server). Links, credential requests, possible MNPI and instructions aimed at automated
     tools are flagged.
3. **Manual meeting control.** Meeting drawer → Edit (day/time/length, room cube, location note,
   bankers with primary, attendees) and Cancel; Schedule → New meeting. A live conflict check
   blocks double-booked issuer/investor/banker/cube and a cube that is too small; outside the
   issuer's availability or a banker marked unavailable needs "Schedule anyway". Every change needs
   a reason and is audited with before/after; moves supersede old drafts and prepare a new
   confirmation draft.
4. **Form-based correction.** "Edit what the AI extracted" is a form: kind of change, operation
   (availability only), event, issuer, investor, attendees, and a list of times (conference day
   picker + start/end in conference time + Available / Proposed / Unavailable). Manual times are
   marked "Entered by reviewer". Raw JSON is behind "Advanced (JSON)". Saving re-titles the queue
   item.
5. **Context resolution.** Sender domain → issuer/investor. With no event named: the only event the
   company is on, else the only active/upcoming event ("Assumed ABS East 2026 — the only event with
   PIMCO on the schedule"), else **Needs triage** with a "Which event?" picker that re-reads the
   email for the chosen event. Triage items appear once in their own lane, not in every
   conference's queue.
6. **Client-safe drafts.** "Ask <sender>" writes a short question per missing fact (exact times for
   quoted vague phrases, the new time, which meeting, which event) — never parser diagnostics or the
   internal note. To/Cc are pre-filled only for a verified external sender; subject "Re: …".
   Sending to a domain outside the registered + internal allowlist needs a second confirmation;
   deal/MNPI keywords block sending until removed ("Remove quoted sensitive text") or confirmed.
7. **Sales ownership.** A request created from an email belongs to the salesperson who sent it or is
   on it (sender, then cc, then to), else the issuer's coverage banker — never the approver.
8. **Bugs.** One definition of open work feeds sidebar, heading, chips and overview; no raw ids in
   UI (meeting dialog, audit trail shows readable labels and the reason, conflict actions named by
   issuer × investor); PDF date and time in separate columns; exports named
   `Corda-<conference>-<audience>.pdf/.xlsx/.ics`; issuer/investor PDFs titled "<Issuer> — Investor
   meeting planner" / "<Investor> — Meeting itinerary" without internal columns; new-request form
   labels ("Requested by", investing-arm label, no defaults); the bell shows recent changes; Help
   counts demo users from data; no silent auto-login (profile picker); sign-out bumps the server
   session version; state-changing routes reject a missing `Origin`.

### How to verify

- `npx tsc --noEmit` and `npm test` (50 tests; `tests/asks.test.ts` covers the 11 acceptance emails
  in `tests/fixtures/v4-emails.json`; `tests/llm-asks.test.ts` covers the LLM multi-ask format with
  a mocked model). `npm run test:integration` passes against a running local server.
- In the app (banker): Action queue → Email reviews → **Paste an email** → drop
  `tests/fixtures/v4-emails.json`. Each entry's `expect` field says what to look for, e.g. the Ford
  reply-all shows Ask 1–3 with the BlackRock/PIMCO meetings pre-selected and "why"; the Bayview
  lookalike shows the red banner and no pre-selection; PennyMac/Discover KKR show Acknowledge &
  assign; "Ask Discover" drafts a question quoting "tues after lunch till ~4ish".
- Schedule → click a meeting → Edit / Cancel; Schedule → New meeting.
- Sign out (sidebar) → profile picker; the old cookie returns 401.

### Not in Phase 1 / known limits

- Without an LLM key the rule parser handles English scheduling phrasing; unusual wording falls back
  to "Ask the sender" rather than guessing. The LLM path is unit-tested with a mocked answer only.
- Escalation detection is keyword-based (also applied to LLM answers).
- "Active/upcoming" uses today's date; the seeded ABS East (Oct 2026) is in the past, so emails
  about companies on it are assumed to belong to it because they are on no other event.
- Moving a meeting keeps a free-text location note; changing the cube does not rewrite it.
