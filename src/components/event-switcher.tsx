'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronsUpDown, MapPin } from 'lucide-react';
import type { AppState } from '@/lib/types';
import { fmt } from './shared';

type Conference = AppState['conferences'][number];

/**
 * Event switcher in the sidebar: a card with the current event, opening a panel beside the
 * sidebar (never clipped by it) that lists every event with place, dates and how far away it is.
 */
export function EventSwitcher({ data, value, onChange }: { data: AppState; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const card = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const current = data.conferences.find((c) => c.id === value)!;
  const today = fmt(data.now, 'America/New_York', 'yyyy-MM-dd');

  const days = (c: Conference) => {
    const s = fmt(`${c.startDate}T12:00:00Z`, 'UTC', 'MMM d');
    const e = fmt(`${c.endDate}T12:00:00Z`, 'UTC', c.startDate.slice(0, 7) === c.endDate.slice(0, 7) ? 'd' : 'MMM d');
    return c.startDate === c.endDate ? s : `${s}–${e}`;
  };
  const when = (c: Conference) => {
    if (today >= c.startDate && today <= c.endDate) return { text: 'Live now', tone: 'live' };
    if (today > c.endDate) return { text: 'Ended', tone: 'past' };
    const n = Math.round((+new Date(`${c.startDate}T12:00:00Z`) - +new Date(`${today}T12:00:00Z`)) / 86400000);
    return { text: n === 1 ? 'Tomorrow' : `In ${n} days`, tone: 'soon' };
  };
  const place = (c: Conference) => (c.location || '').split('·').pop()?.trim() || c.location;

  const toggle = () => {
    if (!open && card.current) {
      const r = card.current.getBoundingClientRect();
      const narrow = window.innerWidth < 900;
      setPos(narrow ? { left: r.left, bottom: window.innerHeight - r.top + 8 } : { left: r.right + 12, bottom: Math.max(12, window.innerHeight - r.bottom) });
    }
    setOpen(!open);
  };
  useEffect(() => {
    if (!open) return;
    const close = (ev: MouseEvent) => {
      if (!panel.current?.contains(ev.target as Node) && !card.current?.contains(ev.target as Node)) setOpen(false);
    };
    const esc = (ev: KeyboardEvent) => ev.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    window.addEventListener('resize', () => setOpen(false), { once: true });
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const w = when(current);
  return (
    <>
      <button ref={card} type="button" className={`v5-evcard ${open ? 'open' : ''}`} onClick={toggle} aria-haspopup="dialog" aria-expanded={open}>
        <span className="lbl">Event</span>
        <span className="name">{current.name}</span>
        <span className="meta">
          {days(current)} · {place(current)}
        </span>
        <span className={`pill ${w.tone}`}>{w.text}</span>
        <ChevronsUpDown size={15} className="chev" aria-hidden="true" />
      </button>
      {open && pos && createPortal(
        <div ref={panel} className="v5-evpanel" role="dialog" aria-label="Switch event" style={{ left: pos.left, bottom: pos.bottom }}>
          <div className="head">Switch event</div>
          <ul>
            {[...data.conferences].sort((a, b) => a.startDate.localeCompare(b.startDate)).map((c) => {
              const s = when(c);
              const on = c.id === value;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    className={on ? 'on' : ''}
                    onClick={() => {
                      onChange(c.id);
                      setOpen(false);
                    }}
                  >
                    <span className="body">
                      <span className="name">{c.name}</span>
                      <span className="meta">
                        <MapPin size={12} /> {c.location}
                      </span>
                      <span className="meta">
                        {days(c)} · {(c as { type?: string }).type || 'Conference'}
                      </span>
                    </span>
                    <span className="side">
                      <span className={`pill ${s.tone}`}>{s.text}</span>
                      {on && <Check size={15} className="ok" />}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>,
        document.body,
      )}
    </>
  );
}
