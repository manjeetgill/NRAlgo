"use client";
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "./button";
import { Dialog, DialogActions, DialogDescription } from "./dialog";

interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
}

const ConfirmContext = createContext<
  ((options: ConfirmOptions) => Promise<boolean>) | undefined
>(undefined);

/** Renders one shared confirm dialog app-wide. Mount once alongside `ToastProvider`. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((value: boolean) => void) | undefined>(undefined);

  const confirm = useCallback((options: ConfirmOptions) => {
    setState(options);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  function settle(value: boolean) {
    setState(null);
    resolver.current?.(value);
    resolver.current = undefined;
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={state !== null}
        onClose={() => settle(false)}
        title={state?.title}
        labelledBy="confirm-dialog-title"
      >
        {state && (
          <>
            {state.description && (
              <DialogDescription>{state.description}</DialogDescription>
            )}
            <DialogActions>
              <Button
                variant="secondary"
                autoFocus
                onClick={() => settle(false)}
              >
                {state.cancelLabel ?? "Cancel"}
              </Button>
              <Button
                variant={state.tone === "danger" ? "danger" : "primary"}
                onClick={() => settle(true)}
              >
                {state.confirmLabel ?? "Confirm"}
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

/** Promise-based replacement for `window.confirm()`: `if (!(await confirm({title, description}))) return;` */
export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error("useConfirm must be used within a ConfirmProvider.");
  }
  return ctx;
}
