import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { AlertTriangle, X } from 'lucide-react';

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Shared dialog behaviour: Escape closes, focus moves into the dialog on open,
 * Tab stays inside it, and focus returns to the opener when it closes.
 */
export function useDialogBehavior(
  dialogRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  { initialFocus = 'field' }: { initialFocus?: 'field' | 'dialog' } = {},
) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (dialog) {
      const firstField = initialFocus === 'field'
        ? dialog.querySelector<HTMLElement>('input:not([type="hidden"]), textarea, select')
        : null;
      (firstField ?? dialog).focus({ preventScroll: true });
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector))
        .filter((element) => element.offsetParent !== null || element === document.activeElement);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      opener?.focus?.({ preventScroll: true });
    };
  }, [dialogRef, initialFocus]);
}

/** Scrim that closes its dialog only when a click both starts and ends on the backdrop. */
export function ModalScrim({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const pressStartedOnScrim = useRef(false);
  return (
    <div
      className="modal-scrim"
      role="presentation"
      onMouseDown={(event) => { pressStartedOnScrim.current = event.target === event.currentTarget; }}
      onClick={(event) => {
        if (pressStartedOnScrim.current && event.target === event.currentTarget) onClose();
        pressStartedOnScrim.current = false;
      }}
    >
      {children}
    </div>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'default',
  onConfirm,
  onCancel,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'default' | 'caution';
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogBehavior(dialogRef, onCancel, { initialFocus: 'dialog' });
  return (
    <ModalScrim onClose={onCancel}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="modal confirm-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-body"
        data-testid="modal-confirm"
      >
        <div className="modal-header">
          <div className="confirm-heading">
            {tone === 'caution' ? <span className="confirm-icon" aria-hidden="true"><AlertTriangle size={17} /></span> : null}
            <h2 id="confirm-dialog-title">{title}</h2>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onCancel}><X size={15} /></button>
        </div>
        <div id="confirm-dialog-body" className="confirm-body">{body}</div>
        <div className="form-actions">
          <button type="button" className="btn btn-quiet" onClick={onCancel} data-testid="button-confirm-cancel">{cancelLabel}</button>
          <button type="button" className="btn btn-primary" onClick={onConfirm} data-testid="button-confirm-accept">{confirmLabel}</button>
        </div>
      </div>
    </ModalScrim>
  );
}
