# Screen implementation

Source of truth: **NRIAlgo_Latest_App_Screens.pdf**, 93 pages, supplied 18 September 2026. It supersedes the earlier PDF and HTML layouts. Reference values are not application data. Each screen has a separate commit; related dialogs belong to their screen. The main-screen sequence now additionally includes Strategy library and Backtest studio between Strategies and Algo lab.

## Delivery sequence

1. Overview — selected-account metrics, real activity, quick actions, responsive shell and fragment navigation.
2. Strategies — saved research library, search, filtering, open/new workflow.
3. Algo lab — real historical research definition and results.
4. Spread builder — option basket research and payoff.
5. Paper trading — quote-driven virtual ledger, when enabled.
6. Option chain — dedicated shared-feed screen and contract details.
7. Orders & trades — actual selected-domain records and export.
8. Broker connections — Kotak session lifecycle, extensible adapter boundary.
9. Live positions — snapshot plus streamed marks and guarded execution controls.
10. Account & security — real password, MFA and session controls.
11. Audit log — actual event search, filters, details and export.

## Invariants

- No fictional balances, canned reports, fake fills, connection status or security state.
- Broker connection never arms execution. Browser verification never sends real orders.
- Paper UI is absent when the server disables paper trading. Historical research remains available.
- Missing data is not zero. Retained marks and incomplete reports carry their warnings.
- Existing unsupported execution capabilities stay unavailable rather than returning simulated success.
- Tests may retain fixtures; they are isolated from the application runtime.

## Verification

Algo lab deliberately exposes the implemented scheduled-basket historical engine, not the reference's nonfunctional MA/sample-return controls. A moving-average signal backtest is not presented as implemented. Save and replay use authenticated research APIs; the report and trade-log dialog contain only returned candle results.

Each screen: TypeScript, relevant automated tests, browser inspection and explicit-path commit. Final gate: full repository checks and production build. Real broker acceptance requires a connected account and is not replaced by fixture tests.
