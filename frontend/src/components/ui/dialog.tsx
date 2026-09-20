"use client";
import { ReactNode, useEffect, useRef } from "react";
import { X } from "lucide-react";
import { clsx } from "clsx";
import styles from "./dialog.module.css";

/** Reusable native `<dialog>` wrapper: focus-trapped, closes on Escape/backdrop click. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  labelledBy = "dialog-title",
  className,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  labelledBy?: string;
  /** Extra class on the `<dialog>` element itself — e.g. a feature-local width override. */
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    if (open && !node.open) {
      node.showModal();
    } else if (!open && node.open) {
      node.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={clsx(styles.dialog, className)}
      aria-labelledby={title ? labelledBy : undefined}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) {
          onClose();
        }
      }}
    >
      <div className={styles.content}>
        {title && (
          <div className={styles.header}>
            <h2 id={labelledBy} className={styles.title}>
              {title}
            </h2>
            <button
              type="button"
              className={styles.close}
              aria-label="Close"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {children}
      </div>
    </dialog>
  );
}

export function DialogDescription({ children }: { children: ReactNode }) {
  return <p className={styles.description}>{children}</p>;
}

export function DialogActions({ children }: { children: ReactNode }) {
  return <div className={styles.actions}>{children}</div>;
}
