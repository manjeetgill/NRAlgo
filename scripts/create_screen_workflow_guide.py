"""Build the implementation-based screen and workflow guide; no account data."""
from pathlib import Path
from xml.sax.saxutils import escape
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'output/pdf/NRIAlgo_Screens_and_Workflows.pdf'
OUT.parent.mkdir(parents=True, exist_ok=True)
styles = getSampleStyleSheet()
for name, size, leading, color in [('Title',30,36,'#132A43'),('Heading1',23,29,'#132A43'),('Heading2',15,20,'#156878'),('Heading3',10,14,'#156878'),('BodyText',10,15,'#26384B')]:
    styles[name].fontName = 'Helvetica-Bold' if name != 'BodyText' else 'Helvetica'
    styles[name].fontSize, styles[name].leading, styles[name].textColor = size, leading, colors.HexColor(color)
    styles[name].spaceAfter = 9
styles.add(ParagraphStyle(name='SmallNote',fontName='Helvetica',fontSize=8,leading=12,textColor=colors.HexColor('#536579'),spaceAfter=8))
styles.add(ParagraphStyle(name='Tagline',fontName='Helvetica-Bold',fontSize=10,leading=15,textColor=colors.HexColor('#156878'),spaceAfter=14))
story=[]
def p(text, style='BodyText'):
    return Paragraph(escape(text),styles[style])
def add(text, style='BodyText'):
    story.append(p(text,style))
def page(title, kicker):
    if story: story.append(PageBreak())
    add(kicker.upper(),'Tagline'); add(title,'Heading1')
def box(title,text):
    t=Table([[p(title,'Heading3')],[p(text)]],colWidths=[475])
    t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),colors.HexColor('#EFF5F8')),('BOX',(0,0),(-1,-1),0.5,colors.HexColor('#D8E5EC')),('LEFTPADDING',(0,0),(-1,-1),12),('RIGHTPADDING',(0,0),(-1,-1),12),('TOPPADDING',(0,0),(-1,0),10),('BOTTOMPADDING',(0,-1),(-1,-1),8)]))
    story.extend([t,Spacer(1,14)])
def table(headers,rows,widths):
    t=Table([[p(x,'SmallNote') for x in headers]]+[[p(x,'SmallNote') for x in row] for row in rows],colWidths=widths,repeatRows=1,hAlign='LEFT')
    t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),colors.HexColor('#DCEBF1')),('VALIGN',(0,0),(-1,-1),'TOP'),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,colors.HexColor('#F5F8FA')]),('LEFTPADDING',(0,0),(-1,-1),8),('RIGHTPADDING',(0,0),(-1,-1),8),('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),5)]))
    story.extend([t,Spacer(1,13)])
def screen(title,route,purpose,steps,result,guard,source):
    add(title,'Heading2'); add(route,'SmallNote'); add(purpose)
    for i,step in enumerate(steps,1): add(f'{i}. {step}')
    add('Result: '+result)
    add('Boundary: '+guard,'SmallNote'); add('Implementation: '+source,'SmallNote')
    story.append(Spacer(1,12))
def steps(items):
    for i,(title,body) in enumerate(items,1):
        box(f'{i:02d}  {title}',body)

page('NRIAlgo\nScreens & workflows','Product and implementation guide | 20 September 2026')
story.append(Spacer(1,32))
add('From selecting a scrip to reviewing a live order','Title')
add('A practical guide to the workspace, research tools, broker connections, data sources and execution safety boundaries.')
story.append(Spacer(1,20))
box('Scope','All 14 primary workspace screens, supporting screens and dialogs, and the main research, portfolio and live-trading workflows.')
box('How to read this document','This is a source-reviewed implementation guide, not a screenshot collection or a live acceptance-test report. Descriptions reflect the working tree reviewed on 20 September 2026, with HEAD be5da7d at inspection. Subsequent changes may alter behavior.')
box('Important distinction','Historical research, broker connection and live execution are separate capabilities. A connected broker does not authorize trading. A model payoff is not a broker margin quote, and a chart is not proof of complete historical coverage.')
add('No credentials, account balances, client identifiers or private trading records are included.','SmallNote')

page('Find every screen','Navigation map')
table(['Section','Screens and route fragments'],[
('Overview','Overview - #/overview'),
('Strategies','Strategies - #/strategies\nStrategy library - #/strategy-library\nAlgo lab - #/algo-lab\nSpread builder - #/spread-builder'),
('Backtesting','Backtest studio - #/backtest-studio'),
('Markets','Watchlists - #/watchlists\nPortfolio - #/portfolio\nOption chain - #/option-chain'),
('Trading','Orders & trades - #/orders\nLive positions - #/live-positions'),
('Settings','Broker connections - #/brokers\nAccount & security - #/security\nAudit log - #/audit')],[115,360])
add('Supporting surfaces','Heading2')
add('Sign-in, broker authorization callback, chart tools, order preview/confirmation, MFA setup and session management are supporting surfaces rather than separate sidebar destinations. Learn the stack is a supporting route. The database inspector is a separate development surface, not a trading workspace screen.')
box('Typical journeys','Explore: Overview > Watchlists > Chart.\nResearch: Strategy library > Backtest studio, or Strategies > Algo lab.\nOptions: Option chain > Spread builder > Payoff review.\nExecution: Settings > Broker connection > Active broker > Separate live authorization > Order preview > Confirm > Reconcile.')
add('Route source: frontend/src/features/workspace/workspace-navigation.ts and workspace-content.tsx.','SmallNote')

page('Account overview and portfolios','Screens 01 - 02')
screen('01 / Overview','#/overview','Account summary and entry point for market, exposure and research work.',[
'Open the workspace and read the selected broker/account and connection status.',
'Review buying power, positions, holdings and data freshness; refresh the account snapshot when needed.',
'Navigate to market tools, broker settings or a dedicated position workflow.'
],'Account values and exposure from the selected implemented adapter, with read-only market intelligence where available.','Buying power is not cash balance. Cached marks and partial failures must not be interpreted as a complete, fresh account.','features/overview/overview-screen.tsx; use-overview-account.ts')
screen('02 / Portfolio','#/portfolio','Durable holdings, positions and funds across broker accounts.',[
'Open the stored dashboard; the current screen initially selects All portfolios.',
'Choose one account or the consolidated view, then explicitly synchronize to refresh broker data.',
'Inspect coverage warnings, valuation and per-account breakdowns; review available performance history.'
],'Stored normalized snapshots and consolidated rows that preserve account provenance.','Portfolio selection is read-only and does not change execution routing. Performance begins with captured snapshots, not inferred historic holdings.','features/portfolio/portfolio-screen.tsx; backend/portfolio-service.ts')

page('Watchlists and option discovery','Screens 03 - 04')
screen('03 / Watchlists','#/watchlists','Maintain personal scrip lists and open the selected instrument chart.',[
'Start with the default list containing NIFTY and BANKNIFTY when catalog matches are available.',
'Type in the instrument search, select an exact result and add it to the selected list.',
'Select a row to open its chart; create a named list or remove a scrip as needed.'
],'Owner-scoped lists stored in PostgreSQL and a chart for the selected stored instrument.','Typing is discovery, not a request to load every matching chart. The current shared chart is stored daily history, not live candles.','features/watchlists/watchlists-screen.tsx; backend/watchlist-routes.ts')
screen('04 / Option chain','#/option-chain','Inspect calls and puts around a selected underlying and expiry.',[
'Select an index or search for a stock, then select the expiry.',
'Choose essential columns or all columns including model-derived Greeks; check live/stored status.',
'Add a leg to the builder, or use B / S to open order review when the connected live path is available.'
],'A compact chain with strike, premium and available analytics; builder context follows selected contracts.','Stored/closed-market data is not executable live pricing. A row selection or B / S action does not immediately submit an order.','features/option-chain/option-chain-screen.tsx; backend/market-data-routes.ts')

page('Strategy organization','Screens 05 - 06')
screen('05 / Strategies','#/strategies','Browse saved strategy definitions and return to the correct research editor.',[
'Open saved strategies and filter the list by cash or spreads.',
'Choose a definition and open it in the associated research workflow.',
'Review the actual definition and parameters before calculating again.'
],'A reusable saved research configuration, independent of live trading permissions.','Saving a definition does not deploy an autonomous trading strategy or authorize a broker order.','features/strategies/strategies-screen.tsx; backend/strategy-research-routes.ts')
screen('06 / Strategy library','#/strategy-library','Explore transparent rule templates before running historical tests.',[
'Read the template rules and assumptions.',
'Choose Configure to continue into Backtest studio.',
'Choose a stored instrument, date range and parameters rather than accepting a hypothetical performance claim.'
],'A configured research starting point. Reference-only content is marked non-runnable.','Template descriptions are not predictions. The Hilega Milega reference is explicitly not a runnable template.','features/strategy-library/strategy-library-screen.tsx; strategy-templates.ts')

page('Historical research','Screens 07 - 08')
screen('07 / Backtest studio','#/backtest-studio','Test supported signal strategies using stored daily cash/index candles.',[
'Select an exact instrument and a date range within available coverage.',
'Set rules and execution assumptions, then submit the historical calculation.',
'Review the calculated equity curve, trade ledger and assumptions together.'
],'A Python-calculated historical report returned through the authenticated application API.','No missing prices are fabricated and no broker-history fallback is silently used. Daily tests do not establish minute-level fill accuracy.','features/backtest-studio/backtest-studio-screen.tsx; calculation_engine/backtest.py')
screen('08 / Algo lab','#/algo-lab','Configure and test a scheduled daily cash basket through the research workbench.',[
'Open a saved cash definition or start a research draft.',
'Select instruments and configure the basket schedule and research settings.',
'Save or run the available research calculation and inspect its results.'
],'A saved basket definition and supported historical research output.','This workbench contains no live execution commands. Use Backtest studio for supported EMA, RSI and breakout signal tests.','features/strategy-lab/strategy-lab-screen.tsx; features/research/research-workbench.tsx')

page('Options construction and order records','Screens 09 - 10')
screen('09 / Spread builder','#/spread-builder','Build an option basket and inspect payoff before any execution decision.',[
'Choose an underlying and available expiry or continue with legs selected in the option chain.',
'Set buy/sell direction, contract, lots and premiums; review dates and volatility assumptions.',
'Inspect the Python-calculated payoff, debit/credit, breakevens, extrema and Greeks; revise the basket.'
],'Analytical payoff for the current basket and its explicit assumptions.','Payoff is not a margin guarantee. The builder does not request the standalone option chain\'s full Greeks data. Research does not submit the basket automatically.','features/spread-builder/; calculation_engine/payoff.py')
screen('10 / Orders & trades','#/orders','Inspect live order and fill records.',[
'Open the live orders view and inspect the available order records.',
'Read order identity, status and fills rather than treating acknowledgement as execution.',
'Use reconciliation and broker review for unresolved or inconsistent outcomes.'
],'Read-only visibility into tracked order progress.','Unknown outcomes require reconciliation, not an automatic retry. Orders retain their original broker association after a settings change.','features/orders/orders-screen.tsx; live-orders-screen.tsx; backend/live/execution.ts')

page('Live exposure and broker settings','Screens 11 - 12')
screen('11 / Live positions','#/live-positions','Monitor exposure and access explicitly gated execution controls.',[
'Check the active broker, session, account state and any halt reason.',
'Review tracked positions and position details.',
'Use the available explicit authorization, order-review and safety controls only when all prerequisites pass.'
],'Position monitoring and supported live order actions behind server-side checks.','Kotak execution is implemented behind enablement; unsupported broker execution fails closed. Halt does not automatically flatten positions.','features/live-trading/; backend/live/kotak-live-manager.ts')
screen('12 / Broker connections','#/brokers','Authorize a broker session and choose the account used for future supported live activity.',[
'For Kotak, enter the requested API token, mobile/UCC, TOTP and MPIN. For Zerodha, configure the app and complete the authorization redirect.',
'Review connection status and select Active live broker.',
'Confirm the switch with the required fresh MFA verification; reconnect after session expiry when prompted.'
],'An authenticated broker session and durable active-broker preference.','Connecting never arms execution. Switching broker clears live permissions, does not move old orders, and does not add unsupported capabilities.','features/brokers/; backend/broker-registry.ts; zerodha-connection.ts')

page('Account security and audit','Screens 13 - 14')
screen('13 / Account & security','#/security','Manage application identity, password, MFA and sessions.',[
'Review the profile and use the dedicated password-change form when needed.',
'Enroll an authenticator using the locally generated QR or manual key, then verify a code.',
'Store recovery codes privately and review/revoke app sessions as appropriate.'
],'Application security settings, separate from broker passwords and execution permissions.','QR enrollment material is sensitive and transient. Revoking a session may disconnect broker access but does not close exchange positions.','features/account/account-screen.tsx; account-sessions.tsx; backend/mfa.ts')
screen('14 / Audit log','#/audit','Read recorded workspace actions and safety events.',[
'Choose an available category and inspect the displayed records.',
'Open an event detail to review its recorded context.',
'Refresh when investigating a recent operation and correlate with order state or operator logs.'
],'A readable trail of recorded application actions.','Audit visibility is not proof that an exchange order was cancelled or filled. Broker reconciliation is still required.','features/activity/activity-screen.tsx; backend/live/execution.ts')

page('Research and data workflows','End-to-end flow A')
steps([
('Select, then load','Search a stored instrument > narrow the results > select its exact catalog identity > request only its history. Watchlist selection opens the shared KLineChart view.'),
('Understand the chart','The present shared chart reads daily OHLC data through /eod/candles. Indicators and drawings are display tools. Underlying history is distinguished from option premium history.'),
('Calculate a strategy','Template or saved definition > instrument/date/rule validation > Express creates or manages a calculation job > private Python calculation > validated result > equity curve, ledger or payoff.'),
('Build options','Underlying > expiry > exact contracts > buy/sell legs and quantities > premium/date/volatility assumptions > Python payoff > revise. This is not an automatic broker submission.'),
('Interpret data availability','During supported market sessions the selected provider is checked for live data. Outside those sessions, stored option data or captured snapshots may be used. Gaps and stale timestamps remain visible; stored data is not relabeled live.')])
add('Historical coverage must be verified independently. A successful chart request does not prove that all securities, dates, corporate actions or expired contracts are present.','SmallNote')

page('Connection is not execution','End-to-end flow B')
steps([
('Connect the account','Authorize Kotak or Zerodha. The app verifies the session and registers the broker. Encrypted session persistence may allow verified restoration; expiry still requires renewed authorization.'),
('Choose the live broker','Settings > Broker connections > Active live broker > confirmation and fresh MFA. The preference is durable. Existing orders retain their bound broker and permissions are cleared on switching.'),
('Prepare and arm','Server enablement, supported adapter, app MFA, broker session, static-IP prerequisites, limits and fresh reconciliation must pass. Explicit arming is time-limited and needs a fresh code.'),
('Preview, confirm, dispatch','Review the exact instrument, quantity and limit price. Bind the intent to its broker, reserve risk under a database lock, persist submission state, then call the broker once. Preview alone submits nothing.'),
('Reconcile or halt','Acknowledged > open > partial fill > filled, cancelled or rejected, according to verified progress. Ambiguous transport outcomes become unknown and require reconciliation. Halt revokes permission; cancellation still needs exchange confirmation.')])
add('Never assume a timeout means rejection, a cancel acknowledgement means cancellation, or a switch changes ownership of existing positions.','SmallNote')

page('What runs on the server','Architecture and storage')
table(['Component','Responsibility / boundary'],[
('React + Next.js','Workspace screens, session-facing UI, shared layouts and chart rendering. Browser commands go to the application API, not directly to broker execution endpoints.'),
('Node.js + Express','Authentication, validation, broker adapters, risk checks, order orchestration, jobs and API responses. Express is the framework running inside Node.'),
('Private Python / FastAPI','Backtests, payoff, Greeks and numerical analysis. Receives validated calculation inputs, not broker credentials or order-placement authority.'),
('PostgreSQL','Users, settings, broker state, watchlists, strategies, jobs, portfolio snapshots, orders and audit. Schema migrations are defined in backend/database.ts.'),
('Historical archive','Verified immutable Parquet may supply daily cash/index candles; PostgreSQL remains the fallback when no valid archive manifest exists. Option history is separate.'),
('External brokers','Session authentication, quotes/account reads and supported execution. Provider capability and account binding must be checked.'),
('Caddy / deployment jobs','Production HTTPS routing and private service topology. Operators apply migrations, configure secrets and run backup/restore procedures.')],[118,357])
box('Local development surfaces','Workspace: localhost:3000. Express API: 8000. Private calculator: 8010. Optional database inspector: 3002. These are development addresses, not instructions to expose all ports in production.')
box('Operator access','The database inspector is authenticated, read-only and owner-filtered. DBeaver/pgAdmin can be used over a private authorized connection; direct writes can violate application invariants. Back up PostgreSQL and the complete historical archive separately where required.')

page('Supporting screens and honest limits','Capability checklist')
table(['Surface / feature','Current interpretation'],[
('Sign-in and session entry','Application authentication precedes the workspace. Broker authorization remains a separate flow.'),
('Zerodha callback','/brokers/zerodha/callback completes the authorized redirect. It is not a regular sidebar page.'),
('Chart tools','KLineChart displays stored daily candles with indicators and drawing tools. Drawings reset on close/reload; license page is /legal/charting.'),
('Order review dialog','Option-chain B / S opens review. Final live submission remains explicitly gated.'),
('Learn the stack','Supporting educational screen, not a primary sidebar section.'),
('Index constituents','Supporting reference page at /reference/index-constituents, separate from live order routing.'),
('Database inspector','Separate development/admin surface; not an ordinary trading screen.')],[135,340])
add('Requested features not yet equivalent to the current implementation','Heading2')
add('1. The requested candle intervals (1m, 5m, 15m, 1h, 1D, 1W, 1M), range presets and broker-live chart updates are not implemented in the inspected shared chart; it still loads stored 1D history.')
add('2. The newer Portfolio dashboard starts with All portfolios. That differs from the earlier request to default every screen to the saved active broker. Portfolio viewing and execution selection remain separate.')
add('3. Zerodha account access does not imply Zerodha live execution. A provider without a configured market-data or execution adapter must remain unavailable rather than silently using another broker.')
add('4. Full NSE historical completeness is not certified by this guide. Verify download manifests, integrity, calendar coverage, instruments and adjustment provenance separately.')

page('Validation and source index','Review and handoff')
add('What has been checked','Heading2')
add('This guide is based on the current navigation registry, screen dispatcher, selected screen implementations, chart component and README architecture/safety documentation. It does not claim a fresh authenticated walkthrough of every screen or a live broker test.')
add('The safety suite added in commit 45dd149 passed 95 offline tests at that commit. It covers risk boundaries, broker-order transitions, submission gates and mocked Kotak/Zerodha behavior. This guide does not rerun or certify deployment acceptance tests.')
box('Before a production trading release','Verify broker authentication/expiry and active selection, current data freshness, market-closed behavior, reconnect paths, preview/confirm, idempotency, unknown outcomes, partial fills, reconciliation, kill controls and backup restoration. Database concurrency/crash recovery and real-broker failure drills remain separate from the unit suite.')
table(['Source group','Primary repository locations'],[
('Navigation and screens','frontend/src/features/workspace/workspace-navigation.ts\nfrontend/src/features/workspace/workspace-content.tsx\nfrontend/src/features/<feature>/'),
('Charts and market data','frontend/src/features/option-chain/contract-price-chart.tsx\nbackend/market-data-routes.ts\nbackend/historical-candle-store.ts'),
('Broker / portfolios','backend/broker-registry.ts\nbackend/zerodha-connection.ts\nbackend/portfolio-service.ts'),
('Safety / calculations','backend/live/contracts.ts, risk.ts, execution.ts\ncalculation_engine/backtest.py, payoff.py'),
('Operations / tests','README.md\nbackend/database.ts, backup.ts\ntests/*.test.mjs\n.github/workflows/checks.yml')],[120,355])
add('Suggested use: product walkthrough, developer onboarding and a checklist for a later screenshot-based acceptance report.','SmallNote')

def footer(canvas,doc):
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor('#D8E5EC')); canvas.line(48,45,A4[0]-48,45)
    canvas.setFont('Helvetica',8); canvas.setFillColor(colors.HexColor('#536579'))
    canvas.drawString(48,31,'NRIAlgo | Screens & workflows | 20 Sep 2026')
    canvas.drawRightString(A4[0]-48,31,str(doc.page))
    canvas.restoreState()
SimpleDocTemplate(str(OUT),pagesize=A4,rightMargin=60,leftMargin=60,topMargin=45,bottomMargin=60,title='NRIAlgo - Screens and Workflows',author='NRIAlgo workspace',pageCompression=1).build(story,onFirstPage=footer,onLaterPages=footer)
print(OUT)
