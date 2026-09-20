import { clsx } from "clsx";
import styles from "./tabs.module.css";

export interface TabItem {
  key: string;
  label: string;
  badge?: string | number;
}

export function Tabs({
  items,
  active,
  onChange,
}: {
  items: TabItem[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className={styles.tabs} role="tablist">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={item.key === active}
          className={clsx(styles.tab, item.key === active && styles.active)}
          onClick={() => onChange(item.key)}
        >
          {item.label}
          {item.badge !== undefined && (
            <span className={styles.badge}>{item.badge}</span>
          )}
        </button>
      ))}
    </div>
  );
}
