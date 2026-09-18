"use client";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** A screen owns its commands; the shell supplies their common heading position. */
export function PageActions({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTarget(document.getElementById("workspace-page-actions"));
  }, []);
  return target ? (
    createPortal(children, target)
  ) : (
    <div className="page-actions">{children}</div>
  );
}
