'use client';
import { useEffect, useId, useRef, useState } from 'react';
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
