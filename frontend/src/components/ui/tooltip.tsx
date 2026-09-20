"use client";
import { ReactNode, useId, useState } from "react";
import styles from "./tooltip.module.css";

/** Hover/focus-triggered info bubble for progressive disclosure instead of always-visible paragraphs. */
export function Tooltip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [visible, setVisible] = useState(false);
  const id = useId();
  return (
    <span
      className={styles.wrapper}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      <span aria-describedby={visible ? id : undefined}>{children}</span>
      {visible && (
        <span role="tooltip" id={id} className={styles.bubble}>
          {label}
        </span>
      )}
    </span>
  );
}
