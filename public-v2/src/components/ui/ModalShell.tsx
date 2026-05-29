import { useEffect, useRef } from 'react';

interface ModalShellProps {
  onClose: () => void;
  children: React.ReactNode;
  maxWidth?: number;
  ariaLabel?: string;
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Wraps `.modal-overlay .modal .modal-close` classes from legacy.css.
 * Closes on Escape, traps focus within the dialog, and restores focus on close.
 */
export function ModalShell({ onClose, children, maxWidth, ariaLabel }: ModalShellProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);

  useEffect(() => {
    triggerRef.current = document.activeElement;
    const el = shellRef.current;
    if (!el) return;

    const focusables = () => Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = focusables()[0];
    first?.focus();

    const trap = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key !== 'Tab') return;
      const nodes = focusables();
      if (!nodes.length) { e.preventDefault(); return; }
      const last = nodes[nodes.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === nodes[0]) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); nodes[0].focus(); }
      }
    };

    document.addEventListener('keydown', trap);
    return () => {
      document.removeEventListener('keydown', trap);
      (triggerRef.current as HTMLElement | null)?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="modal-overlay show"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <div
        ref={shellRef}
        className="modal"
        style={{ position: 'relative', ...(maxWidth ? { maxWidth } : {}) }}
      >
        <button
          type="button"
          className="modal-close"
          aria-label="Cerrar"
          onClick={onClose}
        >
          ✕
        </button>
        {children}
      </div>
    </div>
  );
}
