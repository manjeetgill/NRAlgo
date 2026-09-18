# UI-only parity review — 18 September 2026

## Verdict

### Implementation follow-up

Implemented a first parity pass in the real app, without copying the offline simulation into production. **This is not yet an identical implementation.** User constraints: no demo mode; Kotak only, with ICICI explicitly deferred. The temporary ICICI placeholder was removed and its absence verified in the browser.

Changes applied:

- Shared reference colors, typography, buttons, tables, sidebar sizing and responsive drawer breakpoint.
- Header tour, fullscreen, help and account actions; centered help modal with close/Escape behavior. Sidebar guide now opens product help.
- Reference fragment routes (`audit`, `security`, `brokers`, `orders`, `paper`) while preserving old bookmarks.
- Common heading actions for Strategies, Audit and Backtest studio; workspace refresh moved into help.
- Centered and blurred modal presentation, including Overview activity details.
- Reference-style strategy status filters with honest unavailable states for unsupported deployment statuses; market filtering remains available.
- Audit toolbar/timeline/detail layout and export label. Signed-in/out events now classify as Security, covered by tests.
- Compact seven-column option chain on its dedicated screen; other consumers retain their detailed view.
- Spread summary quantity inputs and remove buttons; Add from option chain now navigates correctly and preserves the in-memory draft.
- Expandable backtest assumptions; Kotak card logo and Verify session label.

Verification: frontend TypeScript passed; frontend tests **69/69** passed; targeted lint passed; production Next.js build passed. Browser checks covered help open/close/Escape, tour Next/Back/Finish/close, strategy status filters, audit Security/details/close, Kotak-only card and connection form open/close, spread navigation, editing/removing draft legs, and mobile menu/help at 390×844. The unsaved draft was discarded by reload and confirmed empty; viewport override reset. No credentials, security settings, saved strategies or orders were changed.

Still outstanding: full Algo lab and Spread builder composition, remaining order/ticket and security-dialog controls, library/backtest detailed layout, Overview account-summary layout, and a full matched screenshot/control sweep. Populated broker-dependent states remain unverified. Paper visibility, broker authentication and execution safeguards remain unchanged. Synthetic fixtures, offline sample successes, demo-reset controls and ICICI are intentionally excluded by the user's constraints.

### Exhaustive-click follow-up: interrupted, not complete

The subsequent control-by-control pass recorded **110 interactions and five disabled-control observations** (65 reference records, 50 implementation records). These are action records, including repeated navigation and field edits, not 115 unique controls or passing tests.

| Area | Additional controls exercised |
| --- | --- |
| Reference shell | Product tour start, Next through all steps, Back, Finish; fullscreen toggle twice |
| Reference Overview | All five activity details and their close buttons; Review security, View all, Create a strategy, Connect a broker, Explore option chain; return navigation |
| App Overview | Broker selector; Refresh snapshot; expand/collapse positions; Review security, Manage broker connections, View all, Create a strategy, Connect a broker, Explore option chain, risk Review; return navigation |
| Reference Strategies | All, Running, Stopped, Draft, Saved filters; no-match search and clearing; Pause; Start paper and simulated confirmation; draft Open |
| App Strategies | All, Cash, Spreads filters; search and clearing; Refresh workspace; New strategy |
| Reference Algo lab | Name, underlying, fast/slow MA, capital, both dates; invalid-parameter attempt; Save draft; sample backtest; trade-log open/close |
| App Algo lab | Cash template, instrument search, Search broker instruments, research name, quantity, entry/exit times, capital, margin, stop, target, slippage, fees; Historical simulator, date, candle interval, batch dates; Live data preview |
| App disabled controls | Run historical simulation, Run batch backtest, Refresh live quotes, Start Kotak live polling, Stop Kotak live polling. Observed disabled; not counted as clicked or successful execution. |
| Reference library | All three Configure & backtest buttons and Browse templates return links |

**Blocker:** implementation at `localhost:3000` stopped responding with connection refused. Read-only listener checks found neither frontend port 3000 nor API port 8000 listening. The normal `NEXUS_NO_BROWSER=1 npm run dev` startup compiled the backend but failed at PostgreSQL startup. The database log reported an existing shared-memory block still in use; port 55432 was already owned by PostgreSQL. No database processes were killed and no database files were removed. The reference preview on 3001 remained available.

**Outstanding:** the exhaustive follow-up still needs the implementation's three library configurations, backtest controls, remaining spread/chain controls, paper/order tabs and row actions, remaining broker/live/security/audit controls, and shared-shell close/cancel/keyboard paths. Earlier representative checks below remain useful but do not complete this exhaustive checklist. Populated broker-dependent and hidden paper states require an isolated fixture environment. Real order execution, credentials, MFA changes and session revocation are excluded from a read-only UI comparison.

The earlier cleanup statement below applies only to the earlier pass. This interrupted follow-up used additional reference-only simulated state and unsaved app form edits; final cleanup could not be verified after the implementation went offline. Repository changes were also present during this audit, so findings describe the inspected build, not a certification of a subsequently changed build.

**The UIs are not exact matches, even when all data values and broker connectivity differences are ignored.** They share screen names and some visual themes, but page composition, controls, labels, dialogs, navigation and spacing differ substantially.

Reference inspected in the browser: `http://127.0.0.1:3001/` (temporary copy of the supplied HTML). Implementation: `http://localhost:3000/`, signed in. Both were inspected at the same narrow in-app browser size (screenshots approximately 612 × 734). This is not a desktop/mobile breakpoint sweep or pixel-diff certification.

All 13 reference destinations were opened. Twelve corresponding app destinations were opened; Paper trading is hidden in the app's current Live workspace mode. The additional Market data and Workspace guide destinations were also opened. Navigation, representative forms, filters, tabs and dialogs were clicked. Disabled/data-dependent controls, real execution, security changes, and every possible control combination were **not** exercised. Hidden controls are not counted as absent merely because they cannot currently be opened.

This review supersedes the earlier source-only report's browser-access limitation. The reference can now be clicked. The earlier Orders `ChunkLoadError` did not recur in this pass: the route loaded its disabled-state UI.

## Global visual differences confirmed in screenshots

| Element | Reference | App |
| --- | --- | --- |
| Header | Menu, screen name, tour/play icon, fullscreen icon, help icon, account avatar | Boxed menu button, Workspace breadcrumb, screen name, Live workspace and Private access indicators; no equivalent reference action cluster |
| Sidebar | Logo and small close icon in a common header; compact workspace card; simulation/reset footer | Separate full-width Close control above the logo; different workspace card, spacing and icons; guide/sign-out actions |
| Main spacing | Compact title/description followed closely by page actions/content | Larger vertical gaps and more padding; extra page-level Refresh workspace action on most screens |
| Primary actions | Blue, relatively flat treatment; some full-width page actions at this viewport | More violet tone with visible shadow; often right-aligned in a separate toolbar |
| Dialog framing | Centered rounded panel, substantial title, subtitle, X close, divided body and footer, blurred/dimmed backdrop | Inspected connection/audit dialogs sit against the top/left of the content viewport; smaller heading, text Close buttons, no matching divided footer or backdrop blur |
| Tables | Compact uppercase headers and reference-specific column sets | Different header treatment, widths, columns and spacing; chain has a prominent purple header |
| Footer | Compact NRIAlgo/simulation footer | Personal workspace/live-trading footer with additional account/approval text |

The dialog discrepancy is particularly clear in Audit log: the reference has a centered event-title dialog with badge, separated rows and bottom-right Close; the app shows a top-positioned “Audit event details” panel with stacked definition-list text and top Close.

## Every reference screen

| Screen | UI-only differences | Browser coverage |
| --- | --- | --- |
| **Overview** | App adds a Broker account selector and separate account-summary section. Metric labels/composition differ. Reference header actions are absent. Banner action placement, spacing and lower-content position differ. Shared title and quick-action concepts are present. | Both screens inspected; app position expansion and event dialog checked in the preceding signed-in pass; reference help/tour opened in this pass |
| **Strategies** | Reference has All/Running/Stopped/Draft/Saved; app has All/Cash/Spreads. Reference includes Mode, P&L and version text; app has Type and no matching P&L/version presentation. Reference Pause/Start paper actions have no equivalents in the saved-research UI. New strategy placement and lower information cards differ. | Both opened; reference Start paper confirmation opened/cancelled; New strategy clicked on both; app search/filter checked in preceding pass |
| **Strategy library** | Three template cards, Hilega reference and Configure & backtest concept align. Header badge placement, descriptions, button arrows, card spacing and final workflow panel differ. Reference “Strategy agent handoff” becomes “Strategy workflow.” | Both opened; EMA Configure & backtest clicked on both; RSI app link checked in preceding pass |
| **Backtest studio** | App inserts a large instrument-search/date/history section before rule parameters. Reference CSV upload and synthetic-fixture controls are absent. Reference assumptions are expandable; app assumptions are a static section. Browse templates and headings/toolbars are positioned differently. | Both forms inspected; reference assumptions expanded and calculated-result state opened; app result state unavailable in current session, so rendered result parity is unverified |
| **Algo lab** | Different form: reference name/underlying/fast MA/slow MA/capital/date range vs app scheduled-basket editor with legs, times and costs. Reference Save draft is at the page head; app Save research strategy is inside the form. App adds three research tabs and saved-strategy controls. | New strategy navigation exercised on both; reference trade-log dialog opened/closed; app tabs checked in preceding pass |
| **Spread builder** | Reference selected-leg table has editable Lots and row trash buttons. App summary has Units/Premium, with editing in a separate detailed form below. Reference top Save strategy, compact entry/exit selectors, sample-backtest button and sticky Review paper order bar are not reproduced. App adds template buttons, embedded chain picker, saved-research controls and research tabs. | Both opened; app Bull call spread revealed editing controls; reference review → acknowledgement → simulated confirmation exercised; app Add from option chain/Load premium quotes checked in preceding pass |
| **Paper trading** | Reference exposes Kotak/ICICI tabs, three summary cards, New order, order list, compact ticket with Buy/Sell switch and Market/Limit selector. App source has a different unit-based limit ticket and additional matching/modification controls; it is not browser-verifiable in the current mode. | Reference screen, New order and Sell ticket state opened; app screen hidden, not classified as missing |
| **Option chain** | Reference has Underlying/Expiry, spot heading and seven table columns; app adds index/constituent selection, separate bid/ask columns, Volume/Change, pagination and moves Open builder above the chain. Reference drawer has a compact depth table, three Greek/IV tiles and full-width Buy/Sell buttons. App contract drawer could not be rendered without a selectable contract. | Both base screens inspected; reference call drawer opened, Add Buy leg exercised and navigation verified; app drawer styling unverified |
| **Orders & trades** | Reference has All/Paper/Live examples tabs, top Export CSV, search, Time column, row Details/Cancel and bottom New paper order. App's current state shows a live-orders heading, Refresh orders and disabled message. Source confirms different filters/columns and no matching full event timeline. | Both opened; reference Details dialog opened/closed. App's populated table, row actions and export appearance remain unverified, rather than counted absent |
| **Broker connections** | Reference has two broker cards with logo tiles and Verify session/Connect sample account. App has one card, Check session/Connect broker, extra portfolio action and different typography/content density. Connection dialogs differ completely in fields and framing. | Both opened; reference connect dialog and app connection form opened/closed; no credentials entered |
| **Live positions** | Reference re-arm warning banner, row Review exit and Emergency controls section differ from app's metric strip, position-snapshot button, expandable execution section and Position safety section. Reference Review flatten all opens a dialog; app button is disabled and labelled Flatten all unavailable. | Both opened; reference re-arm and flatten dialogs opened/cancelled; app execution section expanded; no real execution actions |
| **Account & security** | Reference separately styled Profile/MFA cards, recovery-code button and Device/Session/Last active table differ from the app's inline setup form, session refresh/sign-out-other-devices controls and Session/Device/Expires table. Password dialogs are also different (reference informational panel vs actual input form). | Both opened; password dialogs opened/closed; reference recovery dialog inspected. Real MFA, passwords and sessions unchanged |
| **Audit log** | Reference top Export history and five category tabs vs app Refresh events/Export filtered events and extra Workspace category. Reference timeline and event dialog differ in layout, typography and field arrangement. Search and event-detail concepts exist in both. | Both opened; Security filter exercised on both, app restored to All; event dialogs inspected and compared visually |

## Additional app-only screens

- **Market data:** extra sidebar destination; exposes Instruments, Quotes, Expiries, Option/futures chain, History and WebSocket stream tabs. No corresponding reference screen.
- **Workspace guide:** present, but routes to **Learn the stack**, containing technical architecture cards. The reference's help button opens a product guide dialog and can start a six-step tour. This corrects any reading of the earlier report as claiming the app has no guide button at all.

## Concrete interaction differences

1. Reference **Add from option chain** navigates to the Option chain screen. App's similarly labelled button switches to its local builder tab; when that tab is already selected it makes no visible change (observed in the preceding signed-in pass).
2. Reference **Review paper order** from Spread builder opens a dedicated multi-leg review with expiry text, fee/net-total tiles, checkbox, Back to edit and Confirm. No corresponding action exists in the app spread screen.
3. Reference **New strategy** and app **New strategy** both navigate to Algo lab, but land on materially different forms.
4. Both template configure buttons route to Backtest studio; the app then presents a different set of input controls before the shared strategy parameters.
5. Reference **Workspace help → Start product tour** renders an in-page tour bar. App **Workspace guide** navigates away to technical documentation.
6. Reference **Review flatten all** opens an exit review. App displays a disabled flatten button, so there is no equivalent UI flow.
7. Modal close controls differ: reference X plus footer action; app generally uses text buttons in the heading area.

## Priority if exact UI parity is the target

1. Align the shared shell: header action cluster, sidebar composition, page spacing, action placement, button styles, tables and dialog framing.
2. Rebuild Algo lab and Spread builder presentation around the reference hierarchy, while retaining necessary real-system controls in suitable secondary sections.
3. Match reference strategy filters/table/actions and the paper-review dialog layout.
4. Align library/backtest, connection, live-position, security and audit page composition and labels.
5. Make all intended screen states available in an isolated UI fixture/test environment, so paper mode, populated orders, contract drawers and result views can be compared without changing the real account.
6. Perform matched screenshots at desktop and mobile sizes after alignment. Current evidence is sufficient to reject exact parity, but not to certify unvisited responsive states.

## Scope and cleanup

No implementation code was changed. No app strategy was saved, order submitted, broker connected, credential changed or session revoked. A temporary unsaved app spread template and reference-only simulated calculations/orders were used to inspect UI; both tabs were reloaded and returned to Overview afterward. The preview server remains bound only to `127.0.0.1:3001` and serves the temporary reference copy.

This is a UI comparison, not backend acceptance. Account values, market prices, trading results and connectivity success are deliberately excluded from the verdict. The visible structural/control differences above remain even if both sides are supplied identical data.
