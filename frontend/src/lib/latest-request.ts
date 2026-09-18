/** Framework-independent read gate. Use only for cancellable reads, never to assume a submitted order was undone. */
export function createLatestRequest() {
  let version = 0;
  let controller: AbortController | undefined;
  return {
    /** Supersede the previous read and return a fence that stays false after cancellation or replacement. */
    begin() {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      const expected = ++version;
      return {
        signal: current.signal,
        /** Test freshness after every await, including nested authentication-policy reads. */
        isCurrent: () => version === expected && !current.signal.aborted,
      };
    },
    /** Invalidate all in-flight callbacks on logout, account replacement or unmount. */
    invalidate() {
      version++;
      controller?.abort();
    },
  };
}
