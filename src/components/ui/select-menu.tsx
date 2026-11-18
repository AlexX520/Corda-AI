'use client';
import { Children, Fragment, isValidElement, useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export type SelectOption = { value: string; label: string; hint?: string; group?: string; disabled?: boolean };

/**
 * A styled dropdown in place of the browser's native <select>: same font as the page, a clear
 * selected state, optional second line per option, keyboard support (arrows, Enter, Escape).
 */
export function SelectMenu({
  value,
  onChange,
  options,
  placeholder = 'Choose…',
  ariaLabel,
  disabled,
  variant = 'field',
  className = '',
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  /** field = bordered input look; quiet = text with a chevron (toolbars). */
  variant?: 'field' | 'quiet';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  const current = options.find((o) => o.value === value);
  const enabled = options.filter((o) => !o.disabled);

  useEffect(() => {
    if (!open) return;
    const close = (ev: MouseEvent) => !box.current?.contains(ev.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  useEffect(() => {
    // Long lists (times) open scrolled to the current choice.
    // (menu.scrollTop only: scrollIntoView would also scroll clipped ancestors and shift the page.)
    if (open)
      requestAnimationFrame(() => {
        const menu = box.current?.querySelector<HTMLElement>('.menu');
        const sel = menu?.querySelector<HTMLElement>('.sel');
        if (menu && sel) menu.scrollTop = sel.offsetTop - menu.clientHeight / 2 + sel.offsetHeight / 2;
      });
    if (open) setActive(Math.max(0, enabled.findIndex((o) => o.value === value)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };
  const onKey = (ev: React.KeyboardEvent) => {
    if (disabled) return;
    if (ev.key === 'Escape') return setOpen(false);
    if (['ArrowDown', 'ArrowUp'].includes(ev.key)) {
      ev.preventDefault();
      if (!open) return setOpen(true);
      setActive((a) => (ev.key === 'ArrowDown' ? Math.min(enabled.length - 1, a + 1) : Math.max(0, a - 1)));
    }
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      if (!open) return setOpen(true);
      if (enabled[active]) pick(enabled[active].value);
    }
  };
  let lastGroup: string | undefined;
  return (
    <div ref={box} className={`v5-select ${variant} ${open ? 'open' : ''} ${disabled ? 'disabled' : ''} ${className}`}>
      <button
        type="button"
        className="trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={onKey}
      >
        <span className={current ? 'val' : 'val placeholder'}>{current?.label || placeholder}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open && (
        <ul id={id} role="listbox" className="menu" aria-label={ariaLabel}>
          {options.map((o) => {
            const head = o.group && o.group !== lastGroup ? o.group : null;
            lastGroup = o.group;
            const isActive = enabled[active]?.value === o.value;
            return (
              <li key={`${o.group || ''}:${o.value}`} role="presentation">
                {head && <span className="group">{head}</span>}
                <button
                  type="button"
                  role="option"
                  aria-selected={o.value === value}
                  disabled={o.disabled}
                  className={`${o.value === value ? 'sel' : ''} ${isActive ? 'act' : ''}`}
                  onMouseEnter={() => setActive(enabled.findIndex((x) => x.value === o.value))}
                  onClick={() => pick(o.value)}
                >
                  <span className="txt">
                    <span>{o.label}</span>
                    {o.hint && <small>{o.hint}</small>}
                  </span>
                  {o.value === value && <Check size={14} aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

type OptionNode = { value: string; label: string; disabled?: boolean; group?: string };

/** Plain text of an <option>'s children (strings, numbers, arrays, fragments). */
function textOf(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node.props as { children?: React.ReactNode }).children);
  return '';
}

/** Reads <option> / <optgroup> children (also inside fragments and arrays) into menu options. */
function readOptions(children: React.ReactNode, group?: string, out: OptionNode[] = []): OptionNode[] {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const props = child.props as { value?: string | number; children?: React.ReactNode; disabled?: boolean; label?: string };
    if (child.type === 'option') {
      const label = textOf(props.children);
      out.push({ value: props.value !== undefined ? String(props.value) : label, label, disabled: props.disabled, group });
    } else if (child.type === 'optgroup') readOptions(props.children, props.label, out);
    else if (child.type === Fragment) readOptions(props.children, group, out);
  });
  return out;
}

type SelectChange = { target: { value: string }; currentTarget: { value: string } };

/**
 * Drop-in for a native <select> written with <option> children: same value / onChange(e.target.value)
 * contract, rendered as the styled SelectMenu. `required` keeps working through a hidden input.
 */
export function Select({
  value,
  onChange,
  children,
  required,
  disabled,
  className = '',
  placeholder,
  'aria-label': ariaLabel,
}: {
  value: string | number | undefined;
  onChange: (e: SelectChange) => void;
  children: React.ReactNode;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  'aria-label'?: string;
}) {
  const options = readOptions(children);
  const v = value === undefined || value === null ? '' : String(value);
  const quiet = /\bv5-inline-select\b/.test(className);
  const fire = (next: string) => onChange({ target: { value: next }, currentTarget: { value: next } });
  // An empty-value option is the placeholder ("Choose…"): show it as the prompt, not as a choice.
  const blank = options.find((o) => o.value === '');
  return (
    <span className={`v5-select-wrap ${quiet ? 'inline' : /\bcompact-select\b/.test(className) ? 'compact' : className}`}>
      <SelectMenu
        value={v}
        onChange={fire}
        options={options}
        placeholder={placeholder || blank?.label || 'Choose…'}
        ariaLabel={ariaLabel}
        disabled={disabled}
        variant={quiet ? 'quiet' : 'field'}
        className={/\bcompact-select\b/.test(className) ? 'compact' : ''}
      />
      {required && (
        <input className="v5-select-required" tabIndex={-1} aria-hidden="true" required value={v} onChange={() => undefined} />
      )}
    </span>
  );
}

const clock = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

/** Time of day ("HH:mm") from a styled list in place of the browser's time picker. */
export function TimeSelect({
  value,
  onChange,
  step = 15,
  from = '07:00',
  to = '20:00',
  ariaLabel,
  disabled,
  required,
}: {
  value: string;
  onChange: (v: string) => void;
  step?: number;
  from?: string;
  to?: string;
  ariaLabel?: string;
  disabled?: boolean;
  required?: boolean;
}) {
  const toMin = (t: string) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
  const slots: string[] = [];
  for (let m = toMin(from); m <= toMin(to); m += step) slots.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  // A time off the grid (e.g. 10:10 read from an email) stays selectable.
  if (value && !slots.includes(value.slice(0, 5))) slots.push(value.slice(0, 5));
  slots.sort();
  return (
    <span className="v5-select-wrap">
      <SelectMenu value={value ? value.slice(0, 5) : ''} onChange={onChange} options={slots.map((t) => ({ value: t, label: clock(t) }))} placeholder="Time" ariaLabel={ariaLabel} disabled={disabled} />
      {required && <input className="v5-select-required" tabIndex={-1} aria-hidden="true" required value={value} onChange={() => undefined} />}
    </span>
  );
}

/** One day of the event ("yyyy-MM-dd"), listed as "Dec 8". */
export function DaySelect({
  value,
  onChange,
  startDate,
  endDate,
  ariaLabel,
  required,
}: {
  value: string;
  onChange: (v: string) => void;
  startDate: string;
  endDate: string;
  ariaLabel?: string;
  required?: boolean;
}) {
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const days: string[] = [];
  for (let d = new Date(`${startDate}T12:00:00Z`); d.toISOString().slice(0, 10) <= endDate; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
  return (
    <span className="v5-select-wrap">
      <SelectMenu value={value} onChange={onChange} options={days.map((d) => ({ value: d, label: `${M[+d.slice(5, 7) - 1]} ${+d.slice(8)}` }))} placeholder="Day" ariaLabel={ariaLabel} />
      {required && <input className="v5-select-required" tabIndex={-1} aria-hidden="true" required value={value} onChange={() => undefined} />}
    </span>
  );
}
