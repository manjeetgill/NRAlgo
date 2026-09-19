"use client";
/** Read and mutate the provider-neutral broker registry; credentials never enter this hook. */
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { requestApiJson } from "@/lib/api";

const registeredBrokerSchema = z.object({
  id: z.string().uuid(),
  provider: z.enum(["kotak", "zerodha"]),
  status: z.enum(["connected", "disconnected"]),
  connectedAt: z.number().finite(),
  updatedAt: z.number().finite(),
});
const registrySchema = z.object({
  activeBrokerId: z.string().uuid().nullable(),
  brokers: z.array(registeredBrokerSchema),
});
const selectionSchema = z.object({
  activeBrokerId: z.string().uuid(),
  changed: z.boolean(),
  warning: z.string().nullable(),
});

export type RegisteredBroker = z.infer<typeof registeredBrokerSchema>;

/** Fence stale reads and serialize active-broker changes without retrying mutations. */
export function useBrokerRegistry(csrf: string, refreshKey: number | null) {
  const [registry, setRegistry] = useState<z.infer<typeof registrySchema>>({
    activeBrokerId: null,
    brokers: [],
  });
  const [loading, setLoading] = useState(true);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const generation = useRef(0);
  const mounted = useRef(true);
  const pendingSelection = useRef(false);

  /** Fence promise completions after this broker screen has unmounted. */
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Load owner-scoped broker metadata; cancellation prevents an old screen from updating state. */
  const load = useCallback(async (signal?: AbortSignal) => {
    const version = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const value = registrySchema.parse(
        await requestApiJson(
          "/brokers",
          "GET",
          undefined,
          undefined,
          15000,
          signal,
        ),
      );
      if (
        mounted.current &&
        version === generation.current &&
        !signal?.aborted
      ) {
        setRegistry(value);
      }
    } catch (failure) {
      if (
        mounted.current &&
        version === generation.current &&
        !signal?.aborted
      ) {
        setError(
          failure instanceof Error
            ? failure.message
            : "Broker registry is unavailable.",
        );
      }
    } finally {
      if (
        mounted.current &&
        version === generation.current &&
        !signal?.aborted
      ) {
        setLoading(false);
      }
    }
  }, []);

  /** Refresh after initial mount and after a provider connection check completes. */
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [load, refreshKey]);

  /** Select the broker for future intents; one explicit mutation is followed by one authoritative read. */
  const select = useCallback(
    async (brokerId: string) => {
      if (pendingSelection.current || brokerId === registry.activeBrokerId) {
        return;
      }
      pendingSelection.current = true;
      setSelecting(true);
      setError("");
      setWarning("");
      try {
        const result = selectionSchema.parse(
          await requestApiJson("/brokers/active", "POST", { brokerId }, csrf),
        );
        if (mounted.current) {
          setWarning(result.warning ?? "");
        }
        await load();
      } catch (failure) {
        if (mounted.current) {
          setError(
            failure instanceof Error
              ? failure.message
              : "Active broker could not be changed.",
          );
        }
      } finally {
        pendingSelection.current = false;
        if (mounted.current) {
          setSelecting(false);
        }
      }
    },
    [csrf, load, registry.activeBrokerId],
  );

  return { ...registry, loading, selecting, error, warning, select, load };
}
