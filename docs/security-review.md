# Current security boundaries

Updated 18 September 2026 during the foundation review. See [the detailed findings and verification record](code-review-2026-09-18.md). These are code-level boundaries, not an independent penetration test or production certification.

## Verified application boundaries

- App authentication uses bounded asynchronous scrypt, hashed opaque sessions, CSRF checks and owner-scoped queries. Production flags activate secure cookies, invitation/setup controls and required MFA for broker requests.
- MFA secrets are encrypted and owner/purpose-bound. Token replay/recovery-code reuse are rejected. Password changes and MFA changes revoke broker access.
- Kotak tokens live only in server memory, tied to the authenticating app session. Late login/read completions are fenced against logout, replacement and expiry. TOTP/MPIN are not stored. No credentials or raw broker error objects are returned to the browser.
- Broker HTTPS origins, master CSV paths and feed URLs are allowlisted. REST requests reject redirects, have a ten-second timeout and bounded response sizes. Strict request schemas cannot select an arbitrary URL or broker order method.
- All new market-data reads use the shared research request budget. Stream controls are rate-limited; stop remains a local operation. Feed access is owner/session-bound, expires without a viewer, and is closed on session revocation or errors.
- Stream decoding is bounded and credential-free. Exchange timestamps remain opaque and are never used as proof of freshness for paper fills. Native chain prices are explicitly indicative.
- Paper/research code has no execution capability. Live routes **are mounted** behind authentication, CSRF and disabled-by-default server flags. Kotak execution additionally requires MFA, account/session binding, durable limits, reconciliation and explicit short-lived arming. Read-only market-data adapters do not expose order submission.
- Reading live status no longer opens an execution control session, changes durable permissions, starts monitoring or cancels orders. Explicit control commands own those transitions. Dormant history is selected by app owner and broker-account binding.
- Emergency halt has a separate bounded source/account request budget, so ordinary API quota exhaustion does not block it. Authentication and CSRF still apply. Broker availability, a stalled in-flight operation or database failure can still prevent timely cancellation; use the broker's own controls for emergency intervention.
- Live order intents are persisted before placement, duplicate confirmations reuse the same intent, and uncertain outcomes fail closed instead of blindly resubmitting. Restart/reconnection does not restore authorization. Halt requests cancellation of app-managed orders; it does not flatten positions.
- The browser uses a per-document nonce CSP and same-origin API transport. Unknown broker fields are stripped; displayed data is React text, never broker-supplied HTML.
- Runtime state, keys, builds and test artifacts stay outside Git. Test databases use random disposable schemas, never the user's application schema.

## Local verification

Run `make check`, `make build`, and `npm run test:browser`. The suites cover auth/ownership, paper/research, provider replacement, live risk/OMS transitions, read-only status and independent halt admission. All broker traffic in automated tests is mocked. The browser smoke suite passed locally during the dated review; that does not validate real Kotak behavior.

This review did not reset the application database, change broker credentials, place/cancel real orders, or enable live execution. When restoring an older backup, use a matching application/encryption version or an explicit data/key migration; do not assume older encrypted records are compatible.

## Remaining release gates

1. **Real integrations unverified.** Actual Kotak feed hosts, binary frames, data entitlements, market-hours timestamps and historical coverage require read-only acceptance testing with a real account. Never bypass a host allowlist or stale-price check merely to get a green connection.
2. **Single-instance design.** Session registries, feeds and some rate limits are in memory. Multiple API replicas require coordinated admission limits and broker ownership. Authentication still needs edge abuse protection and load testing before broad public access.
3. **Deployment and recovery remain environment-specific.** The production images built and a disposable database/migration/API/web Compose stack reached healthy status on this host. Actual Lightsail TLS, firewall rules, backup privileges, off-server recovery and monitoring still need deployment testing. Keep the database and API ports private.
4. **Recovery/key rotation incomplete.** There is no public support/account recovery service or automatic encryption-key rotation. Loss of keys makes encrypted data unrecoverable. Keep registration restricted until operations are ready.
5. **No certification.** No independent penetration test, high-load test, OS/image audit, Git-history secret audit or real-money test was performed. Older dependency-audit results are not current proof after a lockfile change; rerun CI audits with working registry access.
6. **CSP and feed memory tradeoffs.** Inline CSS remains allowed; development permits framework evaluation. Native WebSocket frames are checked after Node assembles them, not before allocation. Protocol limits and three connected accounts constrain normal use but do not replace process memory monitoring.
7. **Execution scope is narrow.** Only the documented manual order types are exposed. Multi-leg live submission, auto-strategies, short-option margin, cash-ledger reconciliation and automatic day-book/carry-forward adoption are not implemented. RMS buying power is not settled cash. Risk rejection can also reject an exit; broker-native emergency operations remain necessary. Do not trade the same account concurrently from another client.

Passing local tests does not establish public-production or real-money readiness.
