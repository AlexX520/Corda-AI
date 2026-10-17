# ConferenceOS

A working local MVP for capital-markets conference coordination. Next.js App Router + TypeScript, Tailwind CSS, shadcn-style Radix components, PostgreSQL, Prisma, Zod, date-fns/date-fns-tz, and ExcelJS.

**The database is the source of truth. AI proposes changes; a banker approves them. Available never means confirmed.** No Microsoft 365 credentials or paid AI key are needed.

## Quick start

Requires Node.js 22+ and npm. Use either Docker PostgreSQL or the optional embedded PostgreSQL development server.

```bash
npm install
cp .env.example .env
```

### Option A — Docker PostgreSQL (recommended)

```bash
docker compose up -d
npm run setup
npm run dev
```

### Option B — PostgreSQL without Docker

In terminal 1:

```bash
npm run db:local
```

This runs real PostgreSQL bound to `127.0.0.1:54329`, with durable files in `.data/postgres`. Keep this terminal open. It uses the platform-specific `embedded-postgres` npm package. Docker remains the fallback on unsupported systems. Never run both database options on the same port.

In terminal 2:

```bash
npm run setup
npm run dev
```

Open **http://127.0.0.1:3000**. In demo mode the app opens as Alex Morgan. Use the profile selector at the bottom of the sidebar to switch identity. The first build may take a few seconds. Stop the development server before running `npm run build`; both use `.next`.

For an optimized build:

```bash
npm run build
npm start
```

`npm run setup` generates Prisma Client, applies the checked-in migration, and seeds synthetic data. The seed is repeatable and preserves existing records. `npm run db:migrate`, `npm run db:generate`, and `npm run db:seed` are also available separately.

## Demo identities and data

| Identity     | Role   | Access                                                                    |
| ------------ | ------ | ------------------------------------------------------------------------- |
| Alex Morgan  | Banker | Shared banking operations, email review, scheduling, drafts, audit        |
| Sarah Chen   | Banker | Shared banking operations; coverage owner for Ford Credit and Athene      |
| James Wilson | Sales  | His own seeded and new requests, their meetings, alternatives, own drafts |
| Emma Davis   | Sales  | Her own requests and meetings, initially empty                            |

Seed: ABS East 2026 (October 19–21, America/New_York), a second conference in America/Los_Angeles, six issuers, six investors, approved availability, seven confirmed meetings, a hold, four investor requests, and five emails. Contacts use `.example`/`.demo` addresses. All content is synthetic.

## Try the full workflow

1. **AI Inbox → Bayview updated availability.** Monday 3–5 PM is extracted. Tuesday morning stays unresolved. The PIMCO 3–3:30 PM booking is shown separately and preserved. Approving without resolving uncertainty fails. Request clarification to prepare a local draft without changing availability.
2. **AI Inbox → Athene Tuesday availability.** Review and approve the explicit window. The change persists; available slots and affected requests recalculate.
3. **Sales profile → Request tracker → Bayview / Ford Credit.** The requested time conflicts with PIMCO. Choose a computed alternative. The request becomes _Awaiting Banker Approval_, never _Confirmed_ automatically.
4. **Banker profile → Meeting requests.** Review the new time, enter a room, attest issuer consent, and confirm. A meeting is created, the planner updates, and a confirmation draft is prepared atomically.
5. **Communications.** Review suggested contacts, deliberately select recipients, edit the draft, inspect the meeting-only attachment, and approve simulated delivery. Historical participants are never automatically included. Nothing is sent externally.
6. **Conference planner.** Switch calendar/table views and download a master, issuer, investor, or recipient-filtered Excel planner. Meeting details also offer `.ics` calendar downloads.
7. **Audit trail.** Inspect before/after state for approved changes and simulated deliveries.

## Implemented capabilities

- Banker and Sales workspaces with server-enforced role restrictions, signed HttpOnly demo sessions, and per-salesperson record access.
- Simulated Outlook inbox; pasted emails; JSON and XLSX email imports; unique message-ID deduplication; thread metadata; conference, issuer, category, and status filters.
- Deterministic mock extraction and optional OpenAI-compatible JSON extraction. Both use Zod validation. Quoted replies are removed before extraction. Uncertain associations are left unassigned. Exact source evidence accompanies windows.
- Review cards with original email, proposed values, current availability, overlap information, uncertainty, and an auditable structured JSON editor. Approve, edit, reject, or request clarification.
- Availability add/remove/replace, blocked windows, tentative holds, hold release, source references, coverage owners, calendar cards, and remaining slots. Replacement requires explicit confirmation. Confirmed meetings survive removal or replacement, with an urgent conflict action if left outside availability.
- Meeting requests routed by coverage owner or into an unassigned queue. Interval-based conflict detection includes approved windows, holds, blocks, issuer meetings, and investor meetings. Alternatives use the requested duration and conference slot increment.
- Email confirmations target an explicitly selected request. Reschedule/cancellation reviews target a verified meeting. New meeting-request emails can be approved into an unconfirmed structured request after associations and the interval are complete.
- Action priority/status/assignment, request rejection via cancellation, and automatic status refresh. The UI polls every 10 seconds and refreshes immediately after mutations.
- Planner reads confirmed database meetings directly, so it cannot drift from the approved schedule. Calendar/table views, Excel export, recipient filtering, and meeting-only ICS attachments.
- Editable local drafts, clarification drafts, request-status drafts, recipient approval, and simulated delivery logs. Sending a meeting attachment is limited to that issuer's contact, that investor's contact, and internal bankers.

## Email import format

Use `samples/emails.json` or `samples/emails.xlsx` from **AI Inbox → Add email**. The workbook's first row contains:

```text
messageId | threadId | sender | to | cc | subject | body
```

JSON uses arrays for `to` and `cc`; Excel uses comma-separated email addresses. Optional `conferenceId` / `issuerId` hints explicitly associate a synthetic message. Each row is processed independently and reports success or failure. Limits: 2 MB, 100 emails per import. Reimporting the same message ID is rejected. Imported emails still require review before schedule changes.

Excel planner files are exports, not round-trip database imports. The MVP imports email workbooks rather than silently treating unreviewed planner rows as approved meetings.

## Environment configuration

See `.env.example` for all variables.

| Variable         | Purpose                                                                            |
| ---------------- | ---------------------------------------------------------------------------------- |
| `DATABASE_URL`   | PostgreSQL connection; Docker and embedded defaults match                          |
| `DEMO_MODE`      | Enables deliberate demo profile switching; set `false` outside local synthetic use |
| `SESSION_SECRET` | At least 32 characters; replace the example for any shared environment             |
| `LLM_API_KEY`    | Empty means deterministic mock mode                                                |
| `LLM_BASE_URL`   | OpenAI-compatible `/v1` endpoint                                                   |
| `LLM_MODEL`      | Model name for extraction and optional request draft generation                    |

No LLM calls occur without a key. With a key, only newly ingested email content and known conference/entity context are sent to the configured provider. Invalid JSON, unknown associations, and fabricated evidence are rejected. Provider errors leave ingestion uncommitted so it can be retried. Generated drafts always require review. The mock parser intentionally supports explicit English weekday/AM-PM ranges; unsupported phrasing is flagged for manual review, not guessed.

## Architecture

```text
Banker UI / Sales UI
       │ signed session + same-origin commands
Next.js Route Handlers
       │ Zod validation + role / ownership checks
Domain service
       ├── Email provider → extraction → separate Proposal records
       ├── Review transaction → approved Availability / Meeting
       ├── Deterministic scheduler → request statuses / alternatives
       ├── Confirmation → live planner + local Draft
       └── AuditLog with before / after state
       │
Prisma → PostgreSQL
```

- `src/lib/service.ts`: workflows, approvals, authorization, audit, recalculation.
- `src/lib/scheduling.ts`: pure interval math and conference timezone validation.
- `src/lib/extraction.ts`: mock and configurable LLM extraction; structured schema.
- `src/lib/auth.ts`: signed sessions, banker checks, same-origin mutation guard.
- `src/lib/outlook.ts`: future Graph integration contract and simulated provider.
- `src/app/api/export/route.ts`: authorized Excel and calendar exports.
- `prisma/schema.prisma`: User, Conference, Issuer, Investor, Email, Proposal, Availability, MeetingRequest, Meeting, Action, Draft, AuditLog.

Schedule mutations share a PostgreSQL transaction-scoped advisory lock, and confirmation rechecks conflicts inside that transaction. Two concurrent approvals cannot both reserve the same slot. Database mutation, associated request status, draft creation, and audit entry commit together. The API remains the write boundary; direct SQL bypasses application business rules.

## Tests

```bash
npm test
npm run typecheck
# Requires PostgreSQL, seeded data, and the local web server:
npm run test:integration
# Optional server URL override:
TEST_BASE_URL=http://127.0.0.1:3000 npm run test:integration
```

Unit tests cover overlap edges, adjacent meetings, hold subtraction, duration, merged windows, no invented vague times, quoted replies, classifications, missing meridiems, DST gaps, and conference timezone resolution.

Integration tests create and clean an isolated synthetic conference. They verify proposal isolation, deduplication, review permissions, repeated approval rejection, concurrent booking protection, Sales ownership, alternative selection, preservation of confirmed meetings, clarification drafts, recipient authorization, simulated delivery, XLSX scopes, ICS content, and HTTP authorization. Keep these tests against a local synthetic database.

## MVP boundaries / production work

- **Demo identity only.** This is not enterprise authentication: anyone with local access can choose a demo profile while `DEMO_MODE=true`. Disabling it fails closed; integrate tenant-scoped SSO/session issuance before deployment.
- **No live Microsoft integration.** The Graph adapter is an interface only. Live ingestion/sending requires tenant administrator consent, OAuth token management, webhook verification, permission scoping, and reviewed attachment delivery. No Microsoft credentials are read by this app.
- **Single shared banking team.** Sales ownership is enforced, but per-bank tenancy, issuer-level banking entitlements, retention policies, immutable external audit storage, and enterprise compliance controls are not implemented.
- **Human review handles unsupported language.** There is no automatic clarification response ingestion, recurring availability, or meeting-room capacity management. DST gap times are rejected; repeated fallback-hour times should be entered as explicit ISO timestamps in the review editor.
- **No real-time push.** Polling runs every 10 seconds; notifications live in the action queue.
- **Local delivery simulation.** Delivery approval updates the approved recipients and logs a simulated send; no email leaves the application. After a reschedule, stale unsent drafts are superseded and a new confirmation draft is prepared.

The original supplied brief ended at “Shared Data Model — Implement at least”; the schema above was derived from the specified workflows.
