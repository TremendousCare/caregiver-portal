import { useEffect } from 'react';
import { X } from 'lucide-react';
import s from '../ExecStaffPage.module.css';

export function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className={s.modalBackdrop} onClick={onClose}>
      <div
        className={s.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className={s.modalHeader}>
          <h2 className={s.modalTitle}>{title}</h2>
          <button
            type="button"
            className={s.modalCloseBtn}
            onClick={onClose}
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
