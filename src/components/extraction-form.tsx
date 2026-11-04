'use client';
import { useState } from 'react';
import { eachDayOfInterval, format, parseISO } from 'date-fns';
import { Plus, Trash2 } from 'lucide-react';
import type { AppState } from '@/lib/types';
import type { Extraction, ExtractionWindow } from '@/lib/extraction-schema';
import { categories } from '@/lib/extraction-schema';
import { conferenceTime } from '@/lib/scheduling';
import { fmt } from './shared';

/** The operation follows from the kind of change, except for availability (add / replace / remove). */
export function operationFor(
  category: Extraction['category'],
  current: Extraction['operation'],
): Extraction['operation'] {
  switch (category) {
    case 'Reschedule Request':
      return 'reschedule';
    case 'Meeting Cancellation':
      return 'cancel';
    case 'Meeting Confirmation':
      return 'confirm';
    case 'Escalation / complaint':
      return 'escalate';
    case 'Meeting Update':
      return 'update';
    case 'Issuer Availability Update':
      return ['add', 'replace', 'remove'].includes(current) ? current : 'add';
    default:
      return 'inquiry';
  }
}
const categoryLabel: Record<string, string> = {
  'Issuer Availability Update': 'Availability update',
  'New Meeting Request': 'New meeting request',
  'Meeting Confirmation': 'Meeting confirmation',
  'Reschedule Request': 'Reschedule',
  'Meeting Cancellation': 'Cancellation',
  'Meeting Update': 'Headcount / room update',
  'Escalation / complaint': 'Escalation / complaint',
  'General Conference Inquiry': 'Question (no schedule change)',
  'Unrelated Email': 'Not about the conference',
};
const proposes = (c: Extraction['category']) =>
  ['Reschedule Request', 'New Meeting Request', 'Meeting Confirmation'].includes(c);

/**
 * "Edit what the AI extracted" as a form: kind of change, companies, event and a list of time
 * windows picked from the conference days in conference-local time. Raw JSON stays behind a toggle.
 */
export function ExtractionForm({
  value,
  onChange,
  data,
}: {
  value: Extraction;
  onChange: (e: Extraction) => void;
  data: AppState;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [json, setJson] = useState('');
  const [jsonError, setJsonError] = useState('');
  const conference = data.conferences.find((c) => c.id === value.conferenceId);
  const zone = conference?.timezone || 'America/New_York';
  const days = conference
    ? eachDayOfInterval({
        start: parseISO(conference.startDate),
        end: parseISO(conference.endDate),
      }).map((d) => format(d, 'yyyy-MM-dd'))
    : [];
  const set = (patch: Partial<Extraction>) => onChange({ ...value, ...patch });
  const setWindow = (i: number, w: ExtractionWindow | null) =>
    set({
      windows: w
        ? value.windows.map((x, j) => (j === i ? w : x))
        : value.windows.filter((_, j) => j !== i),
    });
  const local = (w: ExtractionWindow) => ({
    date: fmt(w.start, zone, 'yyyy-MM-dd'),
    from: fmt(w.start, zone, 'HH:mm'),
    to: fmt(w.end, zone, 'HH:mm') === '23:59' ? '23:59' : fmt(w.end, zone, 'HH:mm'),
  });
  const update = (
    i: number,
    part: { date?: string; from?: string; to?: string; kind?: ExtractionWindow['kind'] },
  ) => {
    const w = value.windows[i];
    const cur = local(w);
    const date = part.date ?? cur.date,
      from = part.from ?? cur.from,
      to = part.to ?? cur.to;
    try {
      setWindow(i, {
        ...w,
        kind: part.kind ?? w.kind,
        start: conferenceTime(date, from, zone).toISOString(),
        end: conferenceTime(date, to, zone).toISOString(),
        ...(part.kind
          ? {}
          : {
              source: 'manual',
              evidence:
                w.source === 'manual'
                  ? w.evidence
                  : `Edited by reviewer (email said: ${w.evidence})`,
            }),
      });
    } catch {
      /* incomplete time while typing */
    }
  };
  const kindLabel = (k: ExtractionWindow['kind']) =>
    k === 'availability'
      ? proposes(value.category)
        ? 'Proposed time'
        : 'Available'
      : k === 'unavailable'
        ? 'Unavailable'
        : 'Existing meeting (info)';
  return (
    <div className="xf">
      <div className="xf-grid">
        <label>
          <span>Kind of change</span>
          <select
            value={value.category}
            onChange={(e) => {
              const category = e.target.value as Extraction['category'];
              set({ category, operation: operationFor(category, value.operation) });
            }}
          >
            {categories.map((c) => (
              <option key={c} value={c}>
                {categoryLabel[c]}
              </option>
            ))}
          </select>
        </label>
        {value.category === 'Issuer Availability Update' ? (
          <label>
            <span>Operation</span>
            <select
              value={value.operation}
              onChange={(e) => set({ operation: e.target.value as Extraction['operation'] })}
            >
              <option value="add">Add these times</option>
              <option value="replace">Replace all availability with these</option>
              <option value="remove">Remove these times</option>
            </select>
          </label>
        ) : (
          <label>
            <span>Event</span>
            <EventSelect
              value={value.conferenceId}
              data={data}
              onChange={(conferenceId) => set({ conferenceId })}
            />
          </label>
        )}
        {value.category === 'Issuer Availability Update' && (
          <label>
            <span>Event</span>
            <EventSelect
              value={value.conferenceId}
              data={data}
              onChange={(conferenceId) => set({ conferenceId })}
            />
          </label>
        )}
        <label>
          <span>Issuer</span>
          <select
            value={value.issuerId || ''}
            onChange={(e) => set({ issuerId: e.target.value || null, meetingId: null })}
          >
            <option value="">— Pick the issuer —</option>
            {[...data.issuers]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          <span>Investor</span>
          <select
            value={value.investorId || ''}
            onChange={(e) => set({ investorId: e.target.value || null, meetingId: null })}
          >
            <option value="">— None named —</option>
            {[...data.investors]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
          </select>
        </label>
        {(value.category === 'New Meeting Request' ||
          value.category === 'Meeting Confirmation' ||
          value.category === 'Meeting Update') && (
          <label>
            <span>Attendees (investor side)</span>
            <input
              type="number"
              min={1}
              max={500}
              value={value.attendees ?? ''}
              placeholder="Not stated"
              onChange={(e) =>
                set({ attendees: e.target.value ? Math.max(1, Math.round(+e.target.value)) : null })
              }
            />
          </label>
        )}
      </div>
      <div className="xf-windows">
        <div className="xf-windows-head">
          <strong>Times</strong>
          <span>
            {conference ? `${conference.name} · ${zone.replace('_', ' ')}` : 'Pick the event first'}
          </span>
        </div>
        {value.windows.length === 0 && (
          <p className="xf-empty">No times. Add one only if the sender stated it.</p>
        )}
        {value.windows.map((w, i) => {
          const l = local(w);
          const bad = +new Date(w.end) <= +new Date(w.start);
          return (
            <div className="xf-window" key={i}>
              <select
                aria-label="Day"
                value={l.date}
                disabled={!conference}
                onChange={(e) => update(i, { date: e.target.value })}
              >
                {!days.includes(l.date) && (
                  <option value={l.date}>{l.date} (outside the event)</option>
                )}
                {days.map((d) => (
                  <option key={d} value={d}>
                    {format(parseISO(d), 'EEE, MMM d')}
                  </option>
                ))}
              </select>
              <input
                aria-label="Start time"
                type="time"
                step={300}
                value={l.from}
                disabled={!conference}
                onChange={(e) => update(i, { from: e.target.value })}
              />
              <span>–</span>
              <input
                aria-label="End time"
                type="time"
                step={300}
                value={l.to}
                disabled={!conference}
                onChange={(e) => update(i, { to: e.target.value })}
              />
              <select
                aria-label="Kind"
                value={w.kind}
                onChange={(e) => update(i, { kind: e.target.value as ExtractionWindow['kind'] })}
              >
                {(['availability', 'unavailable', 'existingMeeting'] as const).map((k) => (
                  <option key={k} value={k}>
                    {kindLabel(k)}
                  </option>
                ))}
              </select>
              <button
                aria-label="Remove time"
                className="xf-remove"
                onClick={() => setWindow(i, null)}
              >
                <Trash2 size={14} />
              </button>
              <small className={bad ? 'xf-bad' : ''}>
                {bad
                  ? 'End must be after start.'
                  : w.source === 'manual'
                    ? 'Entered by reviewer'
                    : `From the email: “${w.evidence.slice(0, 120)}”`}
              </small>
            </div>
          );
        })}
        <button
          className="text-button xf-add"
          disabled={!conference}
          onClick={() => {
            // Default to the next half hour still to come (never a past slot).
            const nowMs = Date.now();
            const date = days.find((d) => +conferenceTime(d, '18:00', zone) > nowMs) || days[days.length - 1];
            const next = new Date(Math.max(+conferenceTime(date, '09:00', zone), Math.ceil(nowMs / 1800000) * 1800000));
            set({
              windows: [
                ...value.windows,
                {
                  start: next.toISOString(),
                  end: new Date(+next + 30 * 60000).toISOString(),
                  kind: 'availability',
                  evidence: 'Entered by reviewer',
                  source: 'manual',
                },
              ],
            });
          }}
        >
          <Plus size={14} /> Add a time
        </button>
      </div>
      <button
        className="xf-advanced-toggle"
        onClick={() => {
          setAdvanced(!advanced);
          setJson(JSON.stringify(value, null, 2));
          setJsonError('');
        }}
      >
        {advanced ? 'Hide advanced (JSON)' : 'Advanced (JSON)'}
      </button>
      {advanced && (
        <div className="xf-json">
          <textarea
            rows={10}
            value={json}
            onChange={(e) => setJson(e.target.value)}
            aria-label="Extracted details (JSON)"
          />
          {jsonError && <p className="error">{jsonError}</p>}
          <button
            className="text-button"
            onClick={() => {
              try {
                onChange({ ...value, ...JSON.parse(json) });
                setJsonError('');
              } catch {
                setJsonError('That is not valid JSON.');
              }
            }}
          >
            Apply JSON
          </button>
        </div>
      )}
    </div>
  );
}
export function EventSelect({
  value,
  data,
  onChange,
}: {
  value: string | null;
  data: AppState;
  onChange: (id: string | null) => void;
}) {
  return (
    <select value={value || ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">— Which event? —</option>
      {data.conferences.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name} · {fmt(`${c.startDate}T12:00:00Z`, c.timezone, 'MMM d')}–
          {fmt(`${c.endDate}T12:00:00Z`, c.timezone, 'MMM d')}
        </option>
      ))}
    </select>
  );
}
