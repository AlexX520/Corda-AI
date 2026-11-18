'use client';
import { useMemo, useState } from 'react';
import { CalendarDays, Download, FileSpreadsheet, Mail, Users } from 'lucide-react';
import type { AppState } from '@/lib/types';
import { Button } from './ui/button';
import { fmt, names, type Run } from './shared';
import { myMeetings } from './myday';

/**
 * A banker who is not a coordinator: they cover meetings and say which ones they want, but they
 * do not act on the schedule (Alex, Nov 16). Two pages: My schedule and My preferences.
 */
export function MySchedule({
  data,
  conferenceId,
  onOpenMeeting,
  onPreferences,
}: {
  data: AppState;
  conferenceId: string;
  onOpenMeeting: (id: string) => void;
  onPreferences: () => void;
}) {
  const c = data.conferences.find((x) => x.id === conferenceId)!;
  const zone = c.timezone;
  const n = names(data);
  const me = data.user.id;
  const days: string[] = [];
  for (let d = new Date(`${c.startDate}T12:00:00Z`); d <= new Date(`${c.endDate}T12:00:00Z`); d = new Date(+d + 86400000)) days.push(d.toISOString().slice(0, 10));
  const byDay = days.map((day) => ({ day, list: myMeetings(data, conferenceId, day, zone) }));
  const total = byDay.reduce((s, d) => s + d.list.length, 0);
  const prefs = data.bankerPreferences.filter((p) => p.conferenceId === conferenceId && p.bankerId === me && p.preferenceLevel !== 'No Preference');
  const submitted = prefs.some((p) => p.submissionStatus === 'Submitted');
  const today = fmt(data.now, zone, 'yyyy-MM-dd');
  const daysAway = Math.round((+new Date(`${c.startDate}T12:00:00Z`) - +new Date(`${today}T12:00:00Z`)) / 86400000);
  const room = (m: AppState['meetings'][number]) => {
    const a = data.cubeAssignments.find((x) => x.meetingId === m.id);
    return data.meetingCubes.find((x) => x.id === a?.cubeId)?.name || m.location?.split('·')[0].trim() || 'Room to be confirmed';
  };
  const withWho = (m: AppState['meetings'][number]) =>
    [...new Set([...m.bankerIds, ...data.coverageAssignments.filter((a) => a.meetingId === m.id).map((a) => a.bankerId)])].filter((id) => id !== me).map(n.user);
  const exportHref = (format: 'pdf' | 'xlsx') => `/api/export?conferenceId=${encodeURIComponent(conferenceId)}&scope=banker&id=${encodeURIComponent(me)}&format=${format}`;
  return (
    <div className="v5-page v5-portal">
      <header className="v5-hero">
        <span className="eyebrow">
          {c.name}
          {daysAway > 0 ? ` · starts ${fmt(`${c.startDate}T12:00:00Z`, 'UTC', 'EEE MMM d')} (in ${daysAway} days)` : ''}
        </span>
        <h1>My schedule</h1>
        <p>
          {total ? `You cover ${total} meeting${total === 1 ? '' : 's'} at ${c.name}.` : 'No meetings assigned to you yet.'} The manager assigns
          coverage and rooms; this page updates when allocation is approved.
        </p>
      </header>

      {!submitted && (
        <button className="v5-card v5-prompt" onClick={onPreferences}>
          <Users size={18} />
          <span>
            <strong>Set the meetings you want to cover</strong>
            <span>Pick the issuers you must attend or want to prioritise. Allocation uses it.</span>
          </span>
          <span className="v5-btn primary">Set my preferences</span>
        </button>
      )}

      <div className="v5-portal-actions">
        <a className="v5-btn quiet" href={exportHref('pdf')}>
          <Download size={14} /> My schedule (PDF)
        </a>
        <a className="v5-btn quiet" href={exportHref('xlsx')}>
          <FileSpreadsheet size={14} /> Excel
        </a>
      </div>

      {byDay.map(({ day, list }) => (
        <section key={day} className="v5-stack">
          <div className="v5-section-head">
            <h2>{fmt(`${day}T12:00:00Z`, 'UTC', 'EEEE, MMM d')}</h2>
            <span className="muted">{list.length ? `${list.length} meeting${list.length === 1 ? '' : 's'}` : 'Nothing for you'}</span>
          </div>
          {list.length > 0 && (
            <div className="v5-card v5-list">
              {list.map(({ m, pending }) => (
                <button key={m.id} onClick={() => onOpenMeeting(m.id)}>
                  <span className="t">{fmt(m.start, zone, 'h:mm a')}</span>
                  <strong>
                    {n.issuer(m.issuerId)} × {n.investor(m.investorId)}
                  </strong>
                  <span>
                    {room(m)} · {withWho(m).length ? `with ${withWho(m).join(', ')}` : 'you lead'}
                    {pending ? ' · proposed, not final' : ''}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

const LEVELS = ['Must Attend', 'High Priority', 'Medium Priority', 'Low Priority', 'No Preference', 'Cannot Attend'] as const;
const weight = (l: string) => (l === 'Must Attend' ? 120 : l === 'High Priority' ? 80 : l === 'Medium Priority' ? 45 : l === 'Low Priority' ? 20 : 0);

export function MyPreferences({ data, conferenceId, run }: { data: AppState; conferenceId: string; run: Run }) {
  const c = data.conferences.find((x) => x.id === conferenceId)!;
  const me = data.user.id;
  const current = data.bankerPreferences.filter((p) => p.conferenceId === conferenceId && p.bankerId === me && !p.meetingId);
  const [levels, setLevels] = useState<Record<string, string>>(() => Object.fromEntries(current.map((p) => [p.issuerId, p.preferenceLevel])));
  const [busy, setBusy] = useState(false);
  const issuers = useMemo(() => [...data.issuers].sort((a, b) => a.name.localeCompare(b.name)), [data.issuers]);
  const chosen = Object.values(levels).filter((l) => l !== 'No Preference');
  const submitted = current.some((p) => p.submissionStatus === 'Submitted');
  const deadline = (c as { preferenceDeadline?: string | null }).preferenceDeadline;
  const save = async (submit: boolean) => {
    setBusy(true);
    await run(
      'saveCoveragePreferences',
      {
        conferenceId,
        submit,
        items: Object.entries(levels)
          .filter(([, l]) => l !== 'No Preference')
          .map(([issuerId, preferenceLevel]) => ({ issuerId, preferenceLevel, preferenceWeight: weight(preferenceLevel), isMandatory: preferenceLevel === 'Must Attend' })),
      },
      submit ? 'Preferences sent. Allocation will use them.' : 'Saved as a draft.',
    );
    setBusy(false);
  };
  return (
    <div className="v5-page v5-portal">
      <header className="v5-hero">
        <span className="eyebrow">
          {c.name}
          {deadline ? ` · due ${fmt(deadline, c.timezone, 'EEE MMM d')}` : ''}
          {submitted ? ' · sent' : ''}
        </span>
        <h1>My preferences</h1>
        <p>Which issuers you must attend, want to prioritise, or cannot cover. The manager runs allocation with these.</p>
      </header>
      <div className="v5-card v5-prefs-form">
        {issuers.map((i) => {
          const level = levels[i.id] || 'No Preference';
          return (
            <div key={i.id} className={`row ${level !== 'No Preference' ? 'set' : ''}`}>
              <span className="issuer-dot" style={{ background: i.color }} />
              <strong>{i.name}</strong>
              <div className="levels" role="group" aria-label={`Preference for ${i.name}`}>
                {LEVELS.filter((l) => l !== 'No Preference').map((l) => (
                  <button
                    key={l}
                    className={`${level === l ? 'on' : ''} ${l === 'Must Attend' ? 'must' : l === 'Cannot Attend' ? 'cannot' : ''}`}
                    aria-pressed={level === l}
                    onClick={() => setLevels({ ...levels, [i.id]: level === l ? 'No Preference' : l })}
                  >
                    {l.replace(' Priority', '').replace(' Attend', '')}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="v5-portal-actions sticky">
        <span className="muted">{chosen.length ? `${chosen.length} issuer${chosen.length === 1 ? '' : 's'} chosen` : 'Nothing chosen yet'}</span>
        <Button variant="outline" disabled={busy} onClick={() => save(false)}>
          Save draft
        </Button>
        <Button disabled={busy || !chosen.length} onClick={() => save(true)}>
          Submit preferences
        </Button>
      </div>
      <p className="v5-hint">
        <Mail size={14} /> You can also email the conference mailbox, e.g. “Ford must attend, prioritise Ally, can’t do Santander”. Corda reads it and a
        coordinator confirms it.
      </p>
      <p className="v5-hint">
        <CalendarDays size={14} /> After allocation, your meetings appear on My schedule.
      </p>
    </div>
  );
}
