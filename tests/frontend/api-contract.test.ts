/** Session/error regressions use a local transport stub; never authenticate against a broker. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  requestApiJson,
  subscribeSessionExpiry,
} from "../../frontend/src/lib/api";

test("12-F07 only confirmed app-session expiry notifies the lifecycle owner; MFA 401 does not", async () => {
  const original = globalThis.fetch;
  let expired = 0,
    code = "UNAUTHENTICATED",
    calls = 0;
  const unsubscribe = subscribeSessionExpiry(() => {
    expired++;
  });
  globalThis.fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({
        code,
        detail: "Denied",
        retryable: false,
        correlationId: "12345678-abcd-1234-abcd-123456789abc",
      }),
      { status: 401 },
    );
  };
  try {
    await assert.rejects(requestApiJson("/auth/mfa/confirm", "POST", {}), {
      status: 401,
      code: "UNAUTHENTICATED",
    });
    assert.equal(expired, 0);
    code = "SESSION_EXPIRED";
    await assert.rejects(
      requestApiJson("/market/kotak/feed"),
      (cause: unknown) => {
        const error = cause as Error & {
          correlationId: string;
          retryable: boolean;
        };
        assert.match(error.message, /Reference: 12345678/);
        assert.equal(error.retryable, false);
        return true;
      },
    );
    assert.equal(expired, 1);
    unsubscribe();
    await assert.rejects(requestApiJson("/workspace"));
    assert.equal(expired, 1);
    assert.equal(
      calls,
      3,
      "Failure metadata must never trigger an automatic retry",
    );
  } finally {
    unsubscribe();
    globalThis.fetch = original;
  }
});
