import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Accessible dialog rendered as a centered modal or a right-side drawer. */
export function Modal({ open, onClose, title, children, variant = 'modal', footer }: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  variant?: 'modal' | 'drawer';
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>('[autofocus]') ?? panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === 'Tab' && panel) {
        const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (!items.length) return;
        const firstEl = items[0];
        const lastEl = items[items.length - 1];
        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className={`overlay overlay--${variant}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog dialog--${variant}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={panelRef} tabIndex={-1}>
        <header className="dialog__head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Fermer">×</button>
        </header>
        <div className="dialog__body">{children}</div>
        {footer && <footer className="dialog__foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/** Small modal asking for a single text value (e.g. a composition name). */
export function PromptModal({ open, title, label, initial = '', confirmLabel = 'Valider', onCancel, onConfirm, pending, error }: {
  open: boolean;
  title: string;
  label: string;
  initial?: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: (value: string) => void;
  pending?: boolean;
  error?: ReactNode;
}) {
  const [value, setValue] = useState(initial);
  const id = useId();
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) onConfirm(value.trim());
  };
  return (
    <Modal open={open} onClose={onCancel} title={title}>
      <form onSubmit={submit} className="stack">
        <div className="field">
          <label htmlFor={id} className="field__label">{label}</label>
          <input id={id} className="input" value={value} onChange={(e) => setValue(e.target.value)} autoFocus maxLength={80} />
        </div>
        {error}
        <div className="row row--end">
          <button type="button" className="btn btn--ghost" onClick={onCancel}>Annuler</button>
          <button type="submit" className="btn btn--primary" disabled={!value.trim() || pending}>
            {pending ? 'Enregistrement…' : confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
