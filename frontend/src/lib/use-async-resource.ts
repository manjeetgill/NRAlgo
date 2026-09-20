"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DependencyList,
} from "react";
import { createLatestRequest } from "./latest-request";

export type AsyncStatus = "loading" | "success" | "error";

export interface AsyncResourceState<T> {
  status: AsyncStatus;
  data: T | undefined;
  error: string | undefined;
  refetch: () => void;
}

/** Loads `load` on mount and whenever `deps` change, discarding stale/superseded responses. */
export function useAsyncResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
): AsyncResourceState<T> {
  const [status, setStatus] = useState<AsyncStatus>("loading");
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const gate = useRef(createLatestRequest());
  const loadRef = useRef(load);
  loadRef.current = load;

  const run = useCallback(() => {
    const { signal, isCurrent } = gate.current.begin();
    setStatus("loading");
    setError(undefined);
    loadRef
      .current(signal)
      .then((result) => {
        if (!isCurrent()) {
          return;
        }
        setData(result);
        setStatus("success");
      })
      .catch((err: unknown) => {
        if (!isCurrent()) {
          return;
        }
        setStatus("error");
        setError(err instanceof Error ? err.message : "Request failed.");
      });
  }, []);

  useEffect(() => {
    const requestGate = gate.current;
    run();
    return () => requestGate.invalidate();
    // deps intentionally drive re-fetching; run() itself is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { status, data, error, refetch: run };
}
