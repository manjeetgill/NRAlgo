import { HTMLAttributes } from "react";
import { clsx } from "clsx";
import styles from "./skeleton.module.css";

export function Skeleton({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx(styles.skeleton, className)} {...props} />;
}

/** Stack of skeleton rows sized like a data table while a resource loads. */
export function SkeletonRows({
  rows = 4,
  columns = 4,
}: {
  rows?: number;
  columns?: number;
}) {
  return (
    <div className={styles.rows} role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, row) => (
        <div key={row} className={styles.row}>
          {Array.from({ length: columns }).map((_, col) => (
            <Skeleton key={col} className={styles.cell} />
          ))}
        </div>
      ))}
    </div>
  );
}
