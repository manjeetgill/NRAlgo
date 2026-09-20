"use client";
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
import { clsx } from "clsx";
import styles from "./toast.module.css";

type ToastTone = "success" | "error" | "info";
interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

const ToastContext = createContext<
  ((toast: Omit<ToastItem, "id">) => void) | undefined
>(undefined);

const ICONS: Record<ToastTone, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
};
const DISMISS_MS = 5000;

/** Global toast host. Mount once near the app root; call `useToast()` anywhere for feedback. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (toast: Omit<ToastItem, "id">) => {
      const id = ++nextId.current;
      setToasts((current) => [...current, { ...toast, id }]);
      window.setTimeout(() => dismiss(id), DISMISS_MS);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className={styles.stack} role="region" aria-label="Notifications">
        {toasts.map((toast) => {
          const Icon = ICONS[toast.tone];
          return (
            <div
              key={toast.id}
              className={clsx(styles.toast, styles[toast.tone])}
              role={toast.tone === "error" ? "alert" : "status"}
            >
              <Icon size={16} className={styles.icon} />
              <div className={styles.body}>
                <p className={styles.title}>{toast.title}</p>
                {toast.description && (
                  <p className={styles.description}>{toast.description}</p>
                )}
              </div>
              <button
                type="button"
                aria-label="Dismiss"
                className={styles.dismiss}
                onClick={() => dismiss(toast.id)}
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

/** Fire-and-forget feedback for mutating actions: `toast({tone: "success", title: "Saved"})`. */
export function useToast() {
  const push = useContext(ToastContext);
  if (!push) {
    throw new Error("useToast must be used within a ToastProvider.");
  }
  return push;
}
