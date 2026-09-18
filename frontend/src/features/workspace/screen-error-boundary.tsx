"use client";
/** Contain a screen render/chunk failure without losing navigation or exposing internal error details. */
import { Component, type ReactNode } from "react";
export class ScreenErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  public state = { failed: false };
  /** Render failures must not trigger automatic order retries. */
  public static getDerivedStateFromError() {
    return { failed: true };
  }
  /** Navigating to another screen resets this keyed boundary. */
  public render() {
    return this.state.failed ? (
      <section className="panel" role="alert">
        <h2>This screen could not load.</h2>
        <p>
          Use the sidebar to navigate away and return. If an order was being
          submitted, check its broker status before trying again.
        </p>
      </section>
    ) : (
      this.props.children
    );
  }
}
