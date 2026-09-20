import { HTMLAttributes } from "react";
import { clsx } from "clsx";
import styles from "./badge.module.css";

export type BadgeTone =
  "neutral" | "success" | "danger" | "warning" | "info" | "accent";

export function Badge({
  tone = "neutral",
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span className={clsx(styles.badge, styles[tone], className)} {...props} />
  );
}
