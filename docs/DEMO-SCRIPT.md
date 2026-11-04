# Corda AI — 10-minute demo script

Audience: Global Head of Corporate Access (manager), with a coordinator watching.
Story: *the desk is mid-conference; Corda turns inbox chaos into approved, audited schedule changes.*

## Before the demo (2 minutes)

On the deployed demo (DEMO_MODE=true), sign in as **Morgan Lee** and use **Settings → Reset demo to today**
(type RESET). It does the same as the command below, in one transaction. Every production deploy also reseeds.

```bash
# Move the demo onto today: ABS East runs yesterday → tomorrow, mid-event.
DEMO_RESEED=true npx tsx prisma/seed.ts          # wipes demo tables only (users/Outlook kept)
# Optional, for a rehearsed run: freeze the clock at early afternoon on the conference's middle day
# (set the same value for the seed and the server).
DEMO_NOW=2026-11-03T19:10:00Z DEMO_RESEED=true npx tsx prisma/seed.ts
DEMO_NOW=2026-11-03T19:10:00Z npm run dev
```

The four emails to paste are in `tests/fixtures/demo-emails.json` (sender, to, cc, subject, body).
Keep that file open in a second window.

## 1. Manager view (2 min) — sign in as **Morgan Lee**

1. **Team overview** opens. Say: *"Every number here is computed from the live records. Nothing is typed in."*
   - Fill rate, median time to confirm, open items, escalations.
   - Issuer emails waiting more than 4 hours.
   - **Asks handled by Corda**, with hours saved at a stated 6 minutes per ask.
2. Pick **Discover NDR — Boston** in the event picker: the page narrows to that event (NDR type, 3 meetings).
   Switch back to All events.
3. Click **Escalations open**: the queue opens filtered to escalations. The Apollo escalation is pinned on top
   and its meeting is protected.
4. Back on Team overview, click a coordinator row (for example Sarah Chen): you get her queue. Workload counts
   bankers only.

## 2. Banker hero flow (4 min) — sign in as **Sarah Chen**

1. **My day**: today's meetings with a red **Now** line. Earlier meetings are greyed out and marked Done.
   Tomorrow is fully staffed, each meeting with a room and co-bankers.
2. Action queue → **Email reviews** → **Paste an email**. Paste email **1 (Athene × BlackRock)** and click
   **Analyze email**. The review opens:
   - *"This email answers the open request BlackRock × Athene… Approving confirms it at Wed 11:00 AM and
     closes the request."* No duplicate warning.
   - The yellow box shows the sentence no ask covers: **❓ "Can you also confirm the room has a screen?"**,
     with **Add as question to reply**.
3. Tick **Athene agreed to this time**, click **Confirm request at Wed 11:00 AM**, then **Yes, apply it**.
   The toast reads *"Meeting confirmed … The open request is closed."*
4. The banner asks **Notify both sides?** Click **Draft the reply**. The draft says what was confirmed (time and
   room) and is addressed to the verified contacts. Say: *"Nothing is sent until you press Send."*
5. Paste email **3 (BlackRock escalation)**. It becomes an Urgent escalation pinned to the top. Open
   **Schedule → Ford Credit × BlackRock (tomorrow 3:00 PM)**: a red **Do not move** banner quotes BlackRock.
   Try **Cancel meeting**: an override reason is required.
6. Paste email **4 (look-alike phishing)**. It is flagged red: the domain imitates athene.example and the email
   asks for the investor list to go to Gmail. Nothing is pre-selected. Click **Report phishing** and it is
   quarantined. Corda never shows it as a "newer reply" on the Athene thread.

## 3. Multi-ask email (1 min) — sign in as **Alex Morgan**

Paste email **2 (Bayview reply-all)**. It holds three asks:
- move Ares 10:30 → 11:30;
- cancel PIMCO at 1:30;
- add Fidelity at 2:00.

Each ask shows its checks. Click **Approve all 3 asks…**, tick **Both sides agreed**, then
**Yes, apply all 3**. The results list each outcome.

## 4. Sales (1.5 min) — sign in as **James Wilson**

1. **My clients**: every request and meeting for PIMCO, BlackRock, Wellington, Fidelity and Apollo, each with
   status, reason and priority, plus a change feed.
2. In Find a time, type **"Fidelity wants Ford Credit, Athene and Discover tomorrow"**. Corda finds one time per
   issuer without overlaps, and warns about duplicates *at this event*. **Send 3 requests**.
3. Client itinerary → **PDF** or **Excel** (remaining schedule, location and contact columns) → **Mark as sent**.
   Say: *"Next time, the planner marks only what changed since this send."*

## 5. Ask Corda (30 s) — top-bar **Ask**

Ask:
- "Is Maya covering anything tomorrow before noon?"
- "What changed in the last 2 hours?"
- "Which open emails are about Ford Credit?"
- "Is anyone double-booked tomorrow?"

Each answer lists its sources. For an unsupported question such as "Which investors moved more than twice?"
Corda says *"I can't answer that yet"* and points to the right view instead of guessing.

## Talking points

- No schedule change without a human approval, and every change is in the audit trail with reasons.
- Past meetings cannot be moved. Queue items about times that have passed expire, and they can be reopened.
- The LLM is optional. With it unreachable, Corda falls back to its rule parser in under a second.
