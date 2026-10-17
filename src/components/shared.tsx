'use client';
import { formatInTimeZone } from 'date-fns-tz';
import { cn } from '@/lib/utils';
import type { AppState } from '@/lib/types';
import { Inbox } from 'lucide-react';
export type Run = (type: string, data: unknown, message?: string) => Promise<boolean>;
export function Badge({
  children,
  tone,
  className,
}: {
  children: React.ReactNode;
  tone?: string;
  className?: string;
}) {
  const text = String(children);
  const color =
    tone ||
    (/Confirmed|Approved|Potential Match|Resolved|Available/.test(text) &&
    !text.includes('Alternative')
      ? 'green'
      : /Conflict|Cancelled|Rejected|Urgent/.test(text)
        ? 'red'
        : /review|High|Alternative|Clarification|Hold/.test(text)
          ? 'amber'
          : 'gray');
  return (
    <span className={cn('badge', `badge-${color}`, className)}>
      <span className="badge-dot" />
      {children}
    </span>
  );
}
export const fmt = (value: string, zone = 'America/New_York', pattern = 'EEE, MMM d · h:mm a') =>
  formatInTimeZone(value, zone, pattern);
export const names = (data: AppState) => ({
  issuer: (id: string | null) => data.issuers.find((i) => i.id === id)?.name || 'Unassociated',
  investor: (id: string | null) => data.investors.find((i) => i.id === id)?.name || '—',
  user: (id: string | null) => data.users.find((i) => i.id === id)?.name || 'Unassigned',
  conference: (id: string | null) =>
    data.conferences.find((i) => i.id === id)?.name || 'Unassociated',
});
export function Avatar({
  name,
  color,
  size = 'normal',
}: {
  name: string;
  color?: string;
  size?: string;
}) {
  return (
    <span
      className={cn('avatar', size === 'small' && 'avatar-small')}
      style={{ background: color ? `${color}18` : undefined, color }}
    >
      {name
        .split(' ')
        .map((n) => n[0])
        .slice(0, 2)
        .join('')
        .toUpperCase()}
    </span>
  );
}
export function Empty({ title, description }: { title: string; description: string }) {
  return (
    <div className="empty">
      <Inbox size={28} />
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
