'use client';
import { Select } from './ui/select-menu';
import { useState } from 'react';
import { Check, X } from 'lucide-react';
import type { AppState } from '@/lib/types';
import type { Extraction } from '@/lib/extraction-schema';
import { Button } from './ui/button';
import type { Run } from './shared';

type Email = AppState['emails'][number];
type Proposal = Email['proposals'][number];
const LEVELS = ['Must Attend', 'High Priority', 'Medium Priority', 'Low Priority', 'Cannot Attend'] as const;
type Level = (typeof LEVELS)[number];

/**
 * A banker emailed their coverage preferences. Show what Corda read (issuer, level, the words it
 * came from), let the coordinator fix it, then save it to that banker's preferences for allocation.
 */
export function PreferenceDecision({
  email,
  proposal,
  data,
  run,
  onDone,
}: {
  email: Email;
  proposal: Proposal;
  data: AppState;
  run: Run;
  onDone: () => void;
}) {
  const e = proposal.extraction as unknown as Extraction;
  const banker = data.users.find((u) => u.email.toLowerCase() === email.sender.toLowerCase());
  const issuerName = (id: string) => data.issuers.find((i) => i.id === id)?.name || id;
  const [rows, setRows] = useState(() => (e.preferences || []).map((p) => ({ ...p, level: p.level as Level })));
  const [busy, setBusy] = useState(false);
  const done = proposal.status !== 'Pending';
  const existing = data.bankerPreferences.filter(
    (p) => p.conferenceId === e.conferenceId && p.bankerId === banker?.id && !p.meetingId && p.preferenceLevel !== 'No Preference',
  );
  const save = async () => {
    setBusy(true);
    const ok = await run(
      'applyPreferenceEmail',
      { proposalId: proposal.id, items: rows.map((r) => ({ issuerId: r.issuerId, level: r.level })) },
      `Saved to ${banker?.name || 'the banker'}'s preferences. Allocation uses them next run.`,
    );
    setBusy(false);
    if (ok) onDone();
  };
  return (
    <div className="decision-card v5-prefs">
      <p className="lead">
        {banker?.name || email.sender} sent coverage preferences. Corda read {rows.length === 1 ? 'one issuer' : `${rows.length} issuers`}; check them, then save.
      </p>
      <div className="table">
        {rows.map((r, i) => (
          <div key={r.issuerId} className="row">
            <strong>{issuerName(r.issuerId)}</strong>
            <Select
              value={r.level}
              disabled={done}
              aria-label={`Preference for ${issuerName(r.issuerId)}`}
              onChange={(ev) => setRows(rows.map((x, j) => (j === i ? { ...x, level: ev.target.value as Level } : x)))}
            >
              {LEVELS.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </Select>
            <q>{r.evidence}</q>
            {!done && (
              <button className="v5-icon" aria-label={`Remove ${issuerName(r.issuerId)}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                <X size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
      {existing.length > 0 && !done && (
        <p className="muted-line">
          {banker?.name?.split(' ')[0]} already ranked {existing.length} other issuer{existing.length === 1 ? '' : 's'}; those stay as they are.
        </p>
      )}
      {done ? (
        <div className="dc-waiting">
          <p>{proposal.reviewNote || 'Saved.'}</p>
        </div>
      ) : (
        <div className="dc-actions">
          <Button disabled={busy || !rows.length || !e.conferenceId} onClick={save}>
            <Check size={14} /> Save to {banker?.name?.split(' ')[0] || 'their'}&apos;s preferences
          </Button>
          {!e.conferenceId && <span className="muted-line">Pick the event first.</span>}
        </div>
      )}
    </div>
  );
}
