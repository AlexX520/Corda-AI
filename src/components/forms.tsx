'use client';
import { useState } from 'react';
import { addMinutes } from 'date-fns';
import { conferenceTime } from '@/lib/scheduling';
import type { AppState } from '@/lib/types';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { Field, Run } from './shared';
import { Upload, Sparkles } from 'lucide-react';
export function RequestForm({
  data,
  conferenceId,
  open,
  close,
  run,
}: {
  data: AppState;
  conferenceId: string;
  open: boolean;
  close: () => void;
  run: Run;
}) {
  const [conference, setConference] = useState(conferenceId),
    [issuer, setIssuer] = useState(data.issuers[0].id),
    [investor, setInvestor] = useState(data.investors[0].id),
    [date, setDate] = useState(data.conferences.find((c) => c.id === conferenceId)!.startDate),
    [time, setTime] = useState('15:00'),
    [duration, setDuration] = useState(30),
    [priority, setPriority] = useState('Normal'),
    [notes, setNotes] = useState(''),
    [alternatives, setAlternatives] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const c = data.conferences.find((x) => x.id === conference)!;
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => !v && close()}
      title="New meeting request"
      description="Find the right time. Every meeting remains subject to banker and issuer approval."
    >
      <form
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const start = conferenceTime(date, time, c.timezone);
            if (
              await run(
                'request',
                {
                  conferenceId: conference,
                  issuerId: issuer,
                  investorId: investor,
                  start: start.toISOString(),
                  end: addMinutes(start, duration).toISOString(),
                  duration,
                  priority,
                  notes,
                  alternativeDates: alternatives
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean),
                },
                'Request submitted to the coverage banker',
              )
            )
              close();
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Conference">
          <select
            value={conference}
            onChange={(e) => {
              setConference(e.target.value);
              setDate(data.conferences.find((c) => c.id === e.target.value)!.startDate);
            }}
          >
            {data.conferences.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="two-cols">
          <Field label="Issuer">
            <select value={issuer} onChange={(e) => setIssuer(e.target.value)}>
              {data.issuers.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Investor">
            <select value={investor} onChange={(e) => setInvestor(e.target.value)}>
              {data.investors.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="two-cols">
          <Field label="Preferred date">
            <input
              type="date"
              required
              min={c.startDate}
              max={c.endDate}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
          <Field label="Start time" hint={c.timezone}>
            <input type="time" required value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
        </div>
        <div className="two-cols">
          <Field label="Duration">
            <select value={duration} onChange={(e) => setDuration(+e.target.value)}>
              {[15, 30, 45, 60, 90].map((d) => (
                <option key={d} value={d}>
                  {d} minutes
                </option>
              ))}
            </select>
          </Field>
          <Field label="Priority">
            <select value={priority} onChange={(e) => setPriority(e.target.value)}>
              {['Normal', 'High', 'Urgent'].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Alternative preferred dates" hint="Optional · comma-separated dates">
          <input
            placeholder="2026-10-20, 2026-10-21"
            value={alternatives}
            onChange={(e) => setAlternatives(e.target.value)}
          />
        </Field>
        <Field label="Notes">
          <textarea
            rows={3}
            placeholder="Meeting objectives, attendees, or other preferences…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
        <div className="notice">
          Requesting salesperson: <strong>{data.user.name}</strong>
          <br />
          Assigned banker:{' '}
          {data.users.find((u) => u.id === data.issuers.find((i) => i.id === issuer)?.ownerId)
            ?.name || 'Unassigned queue'}
        </div>
        {error && <p className="error">{error}</p>}
        <Button disabled={busy} type="submit">
          {busy ? 'Submitting…' : 'Submit meeting request'}
        </Button>
      </form>
    </Dialog>
  );
}
export function EmailForm({
  open,
  close,
  run,
  reload,
}: {
  open: boolean;
  close: () => void;
  run: Run;
  reload: () => Promise<void>;
}) {
  const [subject, setSubject] = useState('ABS East 2026 — Bayview availability'),
    [sender, setSender] = useState('ir@bayview.example'),
    [to, setTo] = useState('alex.morgan@conferenceos.demo'),
    [cc, setCc] = useState(''),
    [body, setBody] = useState(
      'Hi Alex,\n\nBayview is available Monday between 3 PM and 5 PM for ABS East 2026. However, we already have a meeting scheduled between 3 PM and 3:30 PM. We can also accommodate meetings Tuesday morning.\n\nBest,\nRachel',
    ),
    [messageId, setMessageId] = useState(`synthetic-${Date.now()}`),
    [threadId, setThreadId] = useState('thread-bayview-availability'),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState(''),
    [dragging, setDragging] = useState(false);
  async function importFiles(files: File[]) {
    if (!files.length) return;
    setBusy(true);
    setResult('');
    let imported = 0;
    const errors: string[] = [];
    for (const file of files) {
      const form = new FormData();
      form.append('file', file);
      try {
        const response = await fetch('/api/import', { method: 'POST', body: form });
        const json = await response.json();
        if (!response.ok || json.error) {
          errors.push(`${file.name}: ${json.error || 'Import failed'}`);
          continue;
        }
        imported += json.results.filter((item: { ok: boolean }) => item.ok).length;
        errors.push(
          ...json.results
            .filter((item: { ok: boolean }) => !item.ok)
            .map((item: { error: string }) => `${file.name}: ${item.error}`),
        );
      } catch {
        errors.push(`${file.name}: Import failed`);
      }
    }
    setResult(`${imported} email${imported === 1 ? '' : 's'} imported.${errors.length ? ` ${errors.join(' ')}` : ''}`);
    await reload();
    setBusy(false);
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => !v && close()}
      title="Add to AI Inbox"
      description="Paste a sample or drop Outlook email files. No Outlook connection needed."
    >
      <form
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            if (
              await run(
                'ingest',
                {
                  messageId,
                  threadId,
                  sender,
                  to: to
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean),
                  cc: cc
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean),
                  subject,
                  body,
                },
                'Email analyzed. Proposed changes are ready for review.',
              )
            )
              close();
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="two-cols">
          <Field label="Sender">
            <input
              type="email"
              required
              value={sender}
              onChange={(e) => setSender(e.target.value)}
            />
          </Field>
          <Field label="To">
            <input required value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <Field label="CC" hint="Comma-separated email addresses">
          <input value={cc} onChange={(e) => setCc(e.target.value)} />
        </Field>
        <Field label="Subject">
          <input required value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="Email body">
          <textarea rows={7} required value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <div className="two-cols">
          <Field label="Message ID">
            <input required value={messageId} onChange={(e) => setMessageId(e.target.value)} />
          </Field>
          <Field label="Thread ID">
            <input required value={threadId} onChange={(e) => setThreadId(e.target.value)} />
          </Field>
        </div>
        <Button disabled={busy} type="submit">
          <Sparkles size={16} />
          {busy ? 'Analyzing…' : 'Analyze email'}
        </Button>
        <div className="divider-label">or drag from Outlook</div>
        <label
          className={`upload outlook-drop ${dragging ? 'dragging' : ''}`}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            event.preventDefault();
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void importFiles(Array.from(event.dataTransfer.files));
          }}
        >
          <Upload size={17} />
          <span><strong>Drop Outlook emails here</strong><small>.eml, .msg, .json, or .xlsx</small></span>
          <input
            type="file"
            accept=".eml,.msg,.json,.xlsx"
            multiple
            disabled={busy}
            onChange={async (e) => {
              await importFiles(Array.from(e.target.files || []));
              e.target.value = '';
            }}
          />
        </label>
        {result && <p className="text-sm text-stone-600">{result}</p>}
      </form>
    </Dialog>
  );
}
export function AvailabilityForm({
  data,
  conferenceId,
  issuerId,
  open,
  close,
  run,
}: {
  data: AppState;
  conferenceId: string;
  issuerId: string;
  open: boolean;
  close: () => void;
  run: Run;
}) {
  const c = data.conferences.find((c) => c.id === conferenceId)!;
  const [issuer, setIssuer] = useState(issuerId),
    [date, setDate] = useState(c.startDate),
    [start, setStart] = useState('09:00'),
    [end, setEnd] = useState('17:00'),
    [kind, setKind] = useState('Available'),
    [operation, setOperation] = useState('add'),
    [replaceConfirmed, setReplaceConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => !v && close()}
      title="Manage issuer availability"
      description={`All times are in ${c.timezone}. Confirmed meetings are preserved.`}
    >
      <form
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            if (
              await run(
                'availability',
                {
                  conferenceId,
                  issuerId: issuer,
                  start: conferenceTime(date, start, c.timezone).toISOString(),
                  end: conferenceTime(date, end, c.timezone).toISOString(),
                  kind,
                  operation,
                  replaceConfirmed,
                },
                'Availability updated and requests recalculated',
              )
            )
              close();
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Issuer">
          <select value={issuer} onChange={(e) => setIssuer(e.target.value)}>
            {data.issuers.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="two-cols">
          <Field label="Operation">
            <select value={operation} onChange={(e) => setOperation(e.target.value)}>
              <option value="add">Add availability / block / hold</option>
              <option value="remove">Remove availability in interval</option>
              <option value="replace">Replace all approved availability</option>
            </select>
          </Field>
          <Field label="Type">
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {['Available', 'Blocked', 'Hold'].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Date">
          <input
            type="date"
            required
            min={c.startDate}
            max={c.endDate}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <div className="two-cols">
          <Field label="From">
            <input type="time" required value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Until">
            <input type="time" required value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        {operation === 'replace' && (
          <label className="check notice">
            <input
              type="checkbox"
              checked={replaceConfirmed}
              onChange={(e) => setReplaceConfirmed(e.target.checked)}
            />
            I explicitly approve replacing all availability for this issuer at this conference.
            Existing meetings remain intact.
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <Button disabled={busy} type="submit">
          Save approved availability
        </Button>
      </form>
    </Dialog>
  );
}
