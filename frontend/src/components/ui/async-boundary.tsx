import { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import type { AsyncStatus } from "@/lib/use-async-resource";
import { Button } from "./button";
import { SkeletonRows } from "./skeleton";
import { EmptyState } from "./empty-state";
import styles from "./async-boundary.module.css";

/** Uniform loading/error/empty handling around a `useAsyncResource` result. */
export function AsyncBoundary({
  status,
  error,
  onRetry,
  isEmpty,
  emptyTitle = "Nothing here yet",
  emptyDescription,
  skeleton,
  children,
}: {
  status: AsyncStatus;
  error?: string;
  onRetry?: () => void;
  isEmpty?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  skeleton?: ReactNode;
  children: ReactNode;
}) {
  if (status === "loading") {
    return <>{skeleton ?? <SkeletonRows />}</>;
  }
  if (status === "error") {
    return (
      <div className={styles.errorPanel} role="alert">
        <AlertTriangle size={18} className={styles.errorIcon} />
        <div>
          <p className={styles.errorTitle}>Couldn&apos;t load this</p>
          <p className={styles.errorMessage}>{error ?? "Request failed."}</p>
        </div>
        {onRetry && (
          <Button
            variant="secondary"
            onClick={onRetry}
            className={styles.retry}
          >
            Retry
          </Button>
        )}
      </div>
    );
  }
  if (isEmpty) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }
  return <>{children}</>;
}
