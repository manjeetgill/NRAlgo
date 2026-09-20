import { HTMLAttributes } from "react";
import { clsx } from "clsx";
import styles from "./card.module.css";

/** Elevated surface for grouping related content, replacing the ad hoc `.panel`/`.metrics` global classes. */
export function Card({
  className,
  padded = true,
  ...props
}: HTMLAttributes<HTMLDivElement> & { padded?: boolean }) {
  return (
    <div
      className={clsx(styles.card, padded && styles.padded, className)}
      {...props}
    />
  );
}

export function CardHeader({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx(styles.header, className)} {...props} />;
}

export function CardTitle({
  className,
  ...props
}: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={clsx(styles.title, className)} {...props} />;
}

export function CardDescription({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={clsx(styles.description, className)} {...props} />;
}
