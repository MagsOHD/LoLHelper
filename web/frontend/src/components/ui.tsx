import type { ReactNode } from 'react';
import type { Role } from '../api/types';
import { ROLE_LABEL, ROLE_SHORT } from '../lib/format';

export function Card({ children, className = '', as: Tag = 'section', ...rest }: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'article' | 'div' | 'li';
} & Record<`aria-${string}`, string | undefined>) {
  return <Tag className={`card ${className}`} {...rest}>{children}</Tag>;
}

export function Chip({ children, selected, onClick, title, tone, disabled }: {
  children: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  title?: string;
  tone?: 'gold' | 'blue' | 'red' | 'green' | 'amber' | 'muted';
  disabled?: boolean;
}) {
  const cls = `chip ${selected ? 'chip--on' : ''} ${tone ? `chip--${tone}` : ''}`;
  if (onClick) {
    return (
      <button type="button" className={cls} aria-pressed={selected} onClick={onClick} title={title} disabled={disabled}>
        {children}
      </button>
    );
  }
  return <span className={cls} title={title}>{children}</span>;
}

export function RoleBadge({ role, compact }: { role: Role; compact?: boolean }) {
  return (
    <span className={`role-badge role-badge--${role.toLowerCase()} ${compact ? 'role-badge--compact' : ''}`} title={ROLE_LABEL[role]}>
      <span aria-hidden="true">{ROLE_SHORT[role]}</span>
      <span className="sr-only">{ROLE_LABEL[role]}</span>
    </span>
  );
}

/** Horizontal 0..1 bar. */
export function Bar({ value, label, tone = 'gold', showValue, size = 'md' }: {
  value: number;
  label: string;
  tone?: 'gold' | 'blue' | 'red' | 'green' | 'amber' | 'teal';
  showValue?: boolean;
  size?: 'sm' | 'md';
}) {
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <div className={`bar bar--${size}`}>
      <div
        className="bar__track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(v * 100)}
      >
        <div className={`bar__fill bar__fill--${tone}`} style={{ width: `${v * 100}%` }} />
      </div>
      {showValue && <span className="bar__value">{Math.round(v * 100)}</span>}
    </div>
  );
}

export function EmptyState({ title, children, action, icon = '✦' }: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: string;
}) {
  return (
    <div className="empty">
      <div className="empty__icon" aria-hidden="true">{icon}</div>
      <p className="empty__title">{title}</p>
      {children && <div className="empty__text">{children}</div>}
      {action && <div className="empty__action">{action}</div>}
    </div>
  );
}

export function ErrorMessage({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="error" role="alert">
      <span aria-hidden="true">⚠</span>
      <span className="error__msg">{msg}</span>
      {onRetry && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={onRetry}>Réessayer</button>
      )}
    </div>
  );
}

export function Skeleton({ height = 16, width = '100%', radius }: { height?: number; width?: number | string; radius?: number }) {
  return <span className="skeleton" style={{ height, width, borderRadius: radius }} aria-hidden="true" />;
}

export function SkeletonCards({ count = 3, height = 140 }: { count?: number; height?: number }) {
  return (
    <div className="grid" aria-busy="true" aria-label="Chargement…">
      {Array.from({ length: count }, (_, i) => (
        <div className="card" key={i}><Skeleton height={height} /></div>
      ))}
    </div>
  );
}

export function Spinner({ label = 'Chargement…' }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="section-title">
      <h2>{children}</h2>
      {action}
    </div>
  );
}

export function BulletList({ items, tone }: { items: string[]; tone?: 'green' | 'amber' | 'red' }) {
  if (!items.length) return <p className="muted">—</p>;
  return (
    <ul className={`bullets ${tone ? `bullets--${tone}` : ''}`}>
      {items.map((s, i) => <li key={i}>{s}</li>)}
    </ul>
  );
}

export function Pips({ value, max = 3, label }: { value: number; max?: number; label: string }) {
  return (
    <span className="pips" role="img" aria-label={`${label} : ${value} sur ${max}`}>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={`pip ${i < value ? 'pip--on' : ''}`} />
      ))}
    </span>
  );
}
