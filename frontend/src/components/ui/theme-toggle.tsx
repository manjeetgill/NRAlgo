"use client";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "./theme-provider";
import styles from "./theme-toggle.module.css";

/** Light/dark switch. Sidebar identity never changes; only the workspace surface does. */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      className={styles.toggle}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      <Sun size={12} className={styles.iconSun} />
      <Moon size={12} className={styles.iconMoon} />
      <span className={styles.thumb} data-dark={isDark} />
    </button>
  );
}
