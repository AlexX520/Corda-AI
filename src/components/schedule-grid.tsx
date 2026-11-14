'use client';
import { useEffect, useRef, useState } from 'react';
import type { AppState } from '@/lib/types';
import type { Extraction } from '@/lib/extraction-schema';
import { isDesk } from '@/lib/roles';
import { fmt, names } from './shared';

type Meeting = AppState['meetings'][number];

/**
 * One conference day at a glance: an issuer per row, time across, a line for "now". Colour says
 * only what needs attention (amber), what must not move (black) and what is already over (grey).
 */
export function DayGrid({
  data,
  conferenceId,
  onOpenMeeting,
  onOpenEmail,
}: {
  data: AppState;
  conferenceId: string;
  onOpenMeeting: (id: string) => void;
  onOpenEmail?: (id: string) => void;
}) {
  const c = data.conferences.find((x) => x.id === conferenceId)!;
  const zone = c.timezone;
  const n = names(data);
  const desk = isDesk(data.user.role);
  const now = new Date(data.now);
  const today = fmt(now.toISOString(), zone, 'yyyy-MM-dd');
  const days: string[] = [];
  for (let d = new Date(`${c.startDate}T12:00:00Z`); d <= new Date(`${c.endDate}T12:00:00Z`); d = new Date(+d + 86400000)) days.push(d.toISOString().slice(0, 10));
  const all = data.meetings.filter((m) => m.conferenceId === conferenceId && m.status === 'Confirmed');
  const dayOf = (m: Meeting) => fmt(m.start, zone, 'yyyy-MM-dd');
  const [day, setDay] = useState(() => (days.includes(today) ? today : days.find((d) => all.some((m) => dayOf(m) === d)) || days[0]));
  const list = all.filter((m) => dayOf(m) === day).sort((a, b) => a.start.localeCompare(b.start));
  const minutes = (iso: string) => Number(fmt(iso, zone, 'H')) * 60 + Number(fmt(iso, zone, 'm'));
  const from = Math.min(9 * 60, ...list.map((m) => Math.floor(minutes(m.start) / 60) * 60));
  const to = Math.max(17 * 60, ...list.map((m) => Math.ceil(minutes(m.end) / 30) * 30));
  const slots = (to - from) / 30;
  // Open email asks that would move or cancel a meeting.
  const asked = new Map<string, { verb: string; emailId: string }>();
  for (const e of data.emails)
    for (const p of e.proposals) {
      if (p.status !== 'Pending') continue;
      const x = p.extraction as unknown as Extraction;
      if (!x || !['reschedule', 'cancel'].includes(x.operation)) continue;
      const hit = list.find((m) => m.id === x.meetingId || (m.issuerId === x.issuerId && m.investorId === x.investorId && (!x.referenceTime || +new Date(x.referenceTime) === +new Date(m.start))));
      if (hit) asked.set(hit.id, { verb: x.operation === 'cancel' ? 'Asked to cancel' : 'Asked to move', emailId: e.id });
    }
  const room = (m: Meeting) => {
    const r = data.cubeAssignments.find((a) => a.meetingId === m.id);
    return data.meetingCubes.find((x) => x.id === r?.cubeId)?.name.replace(/^Meeting /, '') || (m.location ? m.location.split('·')[0].trim() : '');
  };
  const state = (m: Meeting) => {
    if (+new Date(m.end) <= +now) return { tone: 'done', text: 'Done' };
    if ((m as { protected?: boolean }).protected) return { tone: 'hold', text: 'Protected' };
    if (asked.has(m.id)) return { tone: 'warn', text: asked.get(m.id)!.verb };
    if (desk && m.requiresCube && !room(m)) return { tone: 'warn', text: 'Needs a room' };
    const lead = m.bankerIds[0] ? `with ${n.user(m.bankerIds[0]).split(' ')[0]}` : '';
    return { tone: 'ok', text: room(m) || lead || 'Confirmed' };
  };
  const issuers = [...new Set(list.map((m) => m.issuerId))].map((id) => ({ id, name: n.issuer(id) })).sort((a, b) => a.name.localeCompare(b.name));
  const needRoom = desk ? list.filter((m) => +new Date(m.end) > +now && m.requiresCube && !room(m)).length : 0;
  const moving = list.filter((m) => asked.has(m.id)).length;
  const held = list.filter((m) => (m as { protected?: boolean }).protected && +new Date(m.end) > +now).length;
  const nowMin = minutes(now.toISOString());
  const showNow = day === today && nowMin > from && nowMin < to;
  const hourLabel = (min: number) => {
    const h = Math.floor(min / 60);
    return `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
  };
  const label = (d: string) => (d === today ? 'Today' : fmt(`${d}T12:00:00Z`, 'UTC', 'EEE'));
  // Start the view a little before "now" (or the first meeting) instead of at the empty early hours.
  const scroller = useRef<HTMLDivElement>(null);
  const focusMin = showNow ? nowMin - 60 : list.length ? minutes(list[0].start) - 30 : from;
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = Math.max(0, ((focusMin - from) / 30) * 84);
  }, [day, focusMin, from]);

  return (
    <section className="v5-grid-wrap" aria-label="Day schedule">
      <div className="v5-grid-head">
        <h1>{fmt(`${day}T12:00:00Z`, 'UTC', 'EEEE, MMM d')}</h1>
        <div className="v5-seg" role="group" aria-label="Day">
          {days.map((d) => (
            <button key={d} className={d === day ? 'on' : ''} onClick={() => setDay(d)}>
              {label(d)}
            </button>
          ))}
        </div>
        <span className="grow" />
        <span className="zone">{c.name} · times in {zone.replace('America/', '').replace('_', ' ')}</span>
      </div>
      <div className="v5-pills">
        <span>{list.length} meeting{list.length === 1 ? '' : 's'}</span>
        {needRoom > 0 && <span className="warn">{needRoom} need{needRoom === 1 ? 's' : ''} a room</span>}
        {moving > 0 && <span className="warn">{moving} asked to change</span>}
        {held > 0 && <span className="hold">{held} protected</span>}
      </div>
      {list.length ? (
        <div className="v5-card v5-grid-scroll" ref={scroller}>
          <div className="v5-grid" style={{ minWidth: 168 + slots * 84 }}>
            <div className="hours" style={{ gridTemplateColumns: `168px repeat(${slots}, minmax(0, 1fr))` }}>
              <span />
              {Array.from({ length: slots }, (_, i) => (
                <span key={i}>{i % 2 === 0 ? hourLabel(from + i * 30) : ''}</span>
              ))}
            </div>
            <div className="rows">
              {showNow && (
                <span className="now" style={{ left: `calc(168px + (100% - 168px) * ${(nowMin - from) / (to - from)})` }} aria-hidden>
                  <b>Now</b>
                </span>
              )}
              {issuers.map((i) => (
                <div key={i.id} className="row" style={{ gridTemplateColumns: `168px repeat(${slots}, minmax(0, 1fr))` }}>
                  <span className="name">{i.name}</span>
                  {list
                    .filter((m) => m.issuerId === i.id)
                    .map((m) => {
                      const st = state(m);
                      const start = Math.round((minutes(m.start) - from) / 30);
                      const span = Math.max(1, Math.round((minutes(m.end) - minutes(m.start)) / 30));
                      const ask = asked.get(m.id);
                      return (
                        <button
                          key={m.id}
                          className={`block ${st.tone}`}
                          style={{ gridColumn: `${start + 2} / span ${span}` }}
                          title={`${i.name} × ${n.investor(m.investorId)} · ${fmt(m.start, zone, 'h:mm')}–${fmt(m.end, zone, 'h:mm a')} · ${st.text}`}
                          onClick={() => (ask && onOpenEmail && desk ? onOpenEmail(ask.emailId) : onOpenMeeting(m.id))}
                        >
                          <strong>{n.investor(m.investorId)}</strong>
                          <span>{st.text}</span>
                        </button>
                      );
                    })}
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="v5-need calm">
          <span className="v5-dot" />
          <div className="body">
            <strong>No meetings on this day</strong>
            <span>Confirmed meetings appear here as requests are approved.</span>
          </div>
        </div>
      )}
    </section>
  );
}
