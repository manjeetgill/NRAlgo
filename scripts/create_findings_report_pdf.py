"""Generate the NRIAlgo repository review findings report as a polished PDF.

Covers the legal/compliance gaps and the verified code-level bugs found while
reviewing the repository for the planned 50-user beta, with a concrete fix
for each item.
"""

from __future__ import annotations

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    KeepTogether,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

OUTPUT_PATH = Path("output/pdf/nrialgo-findings-and-fixes.pdf")
PAGE_WIDTH, PAGE_HEIGHT = A4

NAVY = colors.HexColor("#0F2747")
BLUE = colors.HexColor("#2563EB")
SKY = colors.HexColor("#EAF2FF")
GREEN = colors.HexColor("#0F9F6E")
GREEN_TINT = colors.HexColor("#E9F8F2")
AMBER = colors.HexColor("#D97706")
AMBER_TINT = colors.HexColor("#FFF4E5")
RED = colors.HexColor("#C2413A")
RED_TINT = colors.HexColor("#FFF0EF")
INK = colors.HexColor("#142033")
SLATE = colors.HexColor("#526178")
MUTED = colors.HexColor("#75839A")
LINE = colors.HexColor("#D9E2EF")
PANEL = colors.HexColor("#F6F8FC")
WHITE = colors.white

SEVERITY_COLORS = {
    "HIGH": (RED, RED_TINT),
    "MEDIUM": (AMBER, AMBER_TINT),
    "LOW": (GREEN, GREEN_TINT),
}


def register_fonts() -> tuple[str, str, str]:
    candidates = [
        (
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "/System/Library/Fonts/Supplemental/Arial Italic.ttf",
        ),
        (
            "/Library/Fonts/Arial.ttf",
            "/Library/Fonts/Arial Bold.ttf",
            "/Library/Fonts/Arial Italic.ttf",
        ),
    ]
    for regular, bold, italic in candidates:
        if Path(regular).exists() and Path(bold).exists() and Path(italic).exists():
            pdfmetrics.registerFont(TTFont("NRIRegular", regular))
            pdfmetrics.registerFont(TTFont("NRIBold", bold))
            pdfmetrics.registerFont(TTFont("NRIItalic", italic))
            return "NRIRegular", "NRIBold", "NRIItalic"
    return "Helvetica", "Helvetica-Bold", "Helvetica-Oblique"


FONT, FONT_BOLD, FONT_ITALIC = register_fonts()


def build_styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "cover_kicker": ParagraphStyle(
            "CoverKicker", parent=base["Normal"], fontName=FONT_BOLD, fontSize=10,
            leading=13, textColor=colors.HexColor("#A9CBFF"), spaceAfter=8, tracking=1.4,
        ),
        "cover_title": ParagraphStyle(
            "CoverTitle", parent=base["Title"], fontName=FONT_BOLD, fontSize=30,
            leading=35, textColor=WHITE, spaceAfter=15,
        ),
        "cover_subtitle": ParagraphStyle(
            "CoverSubtitle", parent=base["Normal"], fontName=FONT, fontSize=13,
            leading=19, textColor=colors.HexColor("#DCE9FF"), spaceAfter=22,
        ),
        "body_small_light": ParagraphStyle(
            "BodySmallLight", parent=base["BodyText"], fontName=FONT, fontSize=8.1,
            leading=11.2, textColor=colors.HexColor("#DCE9FF"), spaceAfter=3,
        ),
        "table_head_light": ParagraphStyle(
            "TableHeadLight", parent=base["Normal"], fontName=FONT_BOLD, fontSize=8,
            leading=10, textColor=WHITE,
        ),
        "title": ParagraphStyle(
            "SectionTitle", parent=base["Heading1"], fontName=FONT_BOLD, fontSize=20,
            leading=25, textColor=NAVY, spaceAfter=7,
        ),
        "subtitle": ParagraphStyle(
            "SectionSubtitle", parent=base["Normal"], fontName=FONT, fontSize=10,
            leading=14.5, textColor=SLATE, spaceAfter=14,
        ),
        "h2": ParagraphStyle(
            "H2", parent=base["Heading2"], fontName=FONT_BOLD, fontSize=12.5,
            leading=16, textColor=NAVY, spaceBefore=2, spaceAfter=5,
        ),
        "h3": ParagraphStyle(
            "H3", parent=base["Heading3"], fontName=FONT_BOLD, fontSize=10.5,
            leading=13.5, textColor=INK, spaceAfter=2,
        ),
        "body": ParagraphStyle(
            "Body", parent=base["BodyText"], fontName=FONT, fontSize=9,
            leading=13, textColor=INK, spaceAfter=6,
        ),
        "body_small": ParagraphStyle(
            "BodySmall", parent=base["BodyText"], fontName=FONT, fontSize=8.3,
            leading=11.8, textColor=INK, spaceAfter=3,
        ),
        "mono_small": ParagraphStyle(
            "MonoSmall", parent=base["BodyText"], fontName=FONT, fontSize=7.6,
            leading=10.6, textColor=SLATE, spaceAfter=2,
        ),
        "bullet": ParagraphStyle(
            "Bullet", parent=base["BodyText"], fontName=FONT, fontSize=8.6,
            leading=12.2, leftIndent=11, firstLineIndent=-7, bulletIndent=0,
            textColor=INK, spaceAfter=3,
        ),
        "table_head": ParagraphStyle(
            "TableHead", parent=base["Normal"], fontName=FONT_BOLD, fontSize=7.6,
            leading=9.6, textColor=WHITE,
        ),
        "table_cell": ParagraphStyle(
            "TableCell", parent=base["Normal"], fontName=FONT, fontSize=7.5,
            leading=10.4, textColor=INK,
        ),
        "table_cell_bold": ParagraphStyle(
            "TableCellBold", parent=base["Normal"], fontName=FONT_BOLD, fontSize=7.5,
            leading=10.4, textColor=INK,
        ),
        "badge": ParagraphStyle(
            "Badge", parent=base["Normal"], fontName=FONT_BOLD, fontSize=7.6,
            leading=9.6, textColor=WHITE, alignment=TA_CENTER,
        ),
        "callout": ParagraphStyle(
            "Callout", parent=base["Normal"], fontName=FONT_BOLD, fontSize=9.5,
            leading=13, textColor=NAVY,
        ),
        "tiny": ParagraphStyle(
            "Tiny", parent=base["Normal"], fontName=FONT, fontSize=6.8,
            leading=8.5, textColor=MUTED,
        ),
    }


STYLES = build_styles()


def p(text: str, style: str = "body") -> Paragraph:
    return Paragraph(text, STYLES[style])


def bullet(text: str) -> Paragraph:
    return Paragraph(f"- {text}", STYLES["bullet"])


def severity_badge(level: str) -> Table:
    accent, _ = SEVERITY_COLORS[level]
    table = Table([[p(level, "badge")]], colWidths=[20 * mm], rowHeights=[6 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), accent),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    return table


def section_header(number: str, title: str, subtitle: str) -> list:
    badge = Table([[p(number, "table_head")]], colWidths=[18 * mm], rowHeights=[8 * mm])
    badge.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), BLUE),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    heading = Table([[badge, [p(title, "title"), p(subtitle, "subtitle")]]], colWidths=[24 * mm, 147 * mm])
    heading.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (0, 0), 6),
        ("RIGHTPADDING", (1, 0), (1, 0), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    return [heading, Spacer(1, 3 * mm)]


def callout(title: str, body: str, tint=SKY, accent=BLUE) -> Table:
    table = Table([[[p(title, "h3"), p(body, "body_small")]]], colWidths=[171 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), tint),
        ("LINEBEFORE", (0, 0), (0, -1), 4, accent),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.Color(accent.red, accent.green, accent.blue, alpha=0.3)),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    return table


def finding_card(severity: str, area: str, title: str, location: str, problem: str, scenario: str, fix: str) -> Table:
    _, tint = SEVERITY_COLORS[severity]
    left = Table([[severity_badge(severity)], [Spacer(1, 2)], [p(area, "tiny")]], colWidths=[24 * mm])
    left.setStyle(TableStyle([
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
    ]))
    body = [
        p(f"<b>{title}</b>", "h3"),
        p(location, "mono_small"),
        Spacer(1, 3),
        p(f"<b>Problem:</b> {problem}", "body_small"),
        p(f"<b>Triggered by:</b> {scenario}", "body_small"),
        p(f"<font color='#0F9F6E'><b>Fix:</b></font> {fix}", "body_small"),
    ]
    table = Table([[left, body]], colWidths=[26 * mm, 145 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, 0), tint),
        ("BACKGROUND", (1, 0), (1, 0), WHITE),
        ("BOX", (0, 0), (-1, -1), 0.7, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (0, 0), 4),
        ("RIGHTPADDING", (0, 0), (0, 0), 4),
        ("TOPPADDING", (0, 0), (0, 0), 8),
        ("BOTTOMPADDING", (0, 0), (0, 0), 8),
        ("LEFTPADDING", (1, 0), (1, 0), 10),
        ("RIGHTPADDING", (1, 0), (1, 0), 10),
        ("TOPPADDING", (1, 0), (1, 0), 8),
        ("BOTTOMPADDING", (1, 0), (1, 0), 8),
    ]))
    return table


def legal_card(severity: str, title: str, problem: str, why_it_matters: str, action: str) -> Table:
    _, tint = SEVERITY_COLORS[severity]
    left = Table([[severity_badge(severity)]], colWidths=[24 * mm])
    left.setStyle(TableStyle([("ALIGN", (0, 0), (-1, -1), "CENTER"), ("VALIGN", (0, 0), (-1, -1), "TOP")]))
    body = [
        p(f"<b>{title}</b>", "h3"),
        Spacer(1, 3),
        p(f"<b>Gap:</b> {problem}", "body_small"),
        p(f"<b>Why it matters:</b> {why_it_matters}", "body_small"),
        p(f"<font color='#0F9F6E'><b>Action:</b></font> {action}", "body_small"),
    ]
    table = Table([[left, body]], colWidths=[26 * mm, 145 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, 0), tint),
        ("BACKGROUND", (1, 0), (1, 0), WHITE),
        ("BOX", (0, 0), (-1, -1), 0.7, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LEFTPADDING", (1, 0), (1, 0), 10),
        ("RIGHTPADDING", (1, 0), (1, 0), 10),
    ]))
    return table


def page_background(canvas, doc) -> None:
    canvas.saveState()
    canvas.setFillColor(PANEL)
    canvas.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, stroke=0, fill=1)
    canvas.setFillColor(WHITE)
    canvas.roundRect(14 * mm, 14 * mm, PAGE_WIDTH - 28 * mm, PAGE_HEIGHT - 28 * mm, 5 * mm, stroke=0, fill=1)
    canvas.setFillColor(NAVY)
    canvas.rect(14 * mm, PAGE_HEIGHT - 22 * mm, PAGE_WIDTH - 28 * mm, 8 * mm, stroke=0, fill=1)
    canvas.setFillColor(WHITE)
    canvas.setFont(FONT_BOLD, 8)
    canvas.drawString(20 * mm, PAGE_HEIGHT - 19 * mm, "NRIALGO  /  REPOSITORY REVIEW FINDINGS")
    canvas.setFillColor(MUTED)
    canvas.setFont(FONT, 7)
    canvas.drawString(20 * mm, 9 * mm, "Repository review  |  Internal document, not legal advice")
    canvas.drawRightString(PAGE_WIDTH - 20 * mm, 9 * mm, f"{doc.page}")
    canvas.restoreState()


def cover_background(canvas, doc) -> None:
    canvas.saveState()
    canvas.setFillColor(NAVY)
    canvas.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, stroke=0, fill=1)
    canvas.setFillColor(colors.HexColor("#123A6C"))
    canvas.circle(PAGE_WIDTH + 8 * mm, PAGE_HEIGHT - 35 * mm, 54 * mm, stroke=0, fill=1)
    canvas.setFillColor(colors.HexColor("#184C86"))
    canvas.circle(PAGE_WIDTH - 7 * mm, PAGE_HEIGHT - 25 * mm, 31 * mm, stroke=0, fill=1)
    canvas.setFillColor(colors.HexColor("#98BCEB"))
    canvas.setFont(FONT, 7)
    canvas.drawString(20 * mm, 14 * mm, "Prepared 20 September 2026  |  NRIAlgo Engineering Review")
    canvas.restoreState()


def make_document() -> BaseDocTemplate:
    doc = BaseDocTemplate(
        str(OUTPUT_PATH), pagesize=A4,
        leftMargin=20 * mm, rightMargin=20 * mm, topMargin=29 * mm, bottomMargin=18 * mm,
        title="NRIAlgo Repository Review — Findings and Fixes",
        author="NRIAlgo Engineering Review",
        subject="Legal/compliance gaps and verified code defects found in review",
    )
    cover_frame = Frame(20 * mm, 20 * mm, PAGE_WIDTH - 40 * mm, PAGE_HEIGHT - 40 * mm, id="cover", showBoundary=0)
    body_frame = Frame(20 * mm, 18 * mm, PAGE_WIDTH - 40 * mm, PAGE_HEIGHT - 45 * mm, id="body", showBoundary=0)
    doc.addPageTemplates([
        PageTemplate(id="Cover", frames=[cover_frame], onPage=cover_background),
        PageTemplate(id="Body", frames=[body_frame], onPage=page_background),
    ])
    return doc


def cover_story() -> list:
    return [
        Spacer(1, 38 * mm),
        p("REPOSITORY REVIEW", "cover_kicker"),
        p("Findings &amp; Fixes Needed", "cover_title"),
        p(
            "A review of the NRIAlgo codebase ahead of the planned 50-user beta: "
            "compliance gaps in the rollout plan, and verified defects in the "
            "live order-execution path.",
            "cover_subtitle",
        ),
        Spacer(1, 10 * mm),
        Table(
            [[
                [p("2 LEGAL / COMPLIANCE GAPS", "table_head_light"), p("No item in the beta plan owns SEBI, ToS, privacy, or data-licensing risk.", "body_small_light")],
                [p("3 VERIFIED CODE DEFECTS", "table_head_light"), p("Confirmed by reading the source; each has a concrete trigger and fix.", "body_small_light")],
            ]],
            colWidths=[85.5 * mm, 85.5 * mm],
            style=TableStyle([
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#17385F")),
                ("BOX", (0, 0), (-1, -1), 0.7, colors.HexColor("#315B89")),
                ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#315B89")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 9),
                ("RIGHTPADDING", (0, 0), (-1, -1), 9),
                ("TOPPADDING", (0, 0), (-1, -1), 9),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
            ]),
        ),
        Spacer(1, 36 * mm),
        p("SCOPE", "cover_kicker"),
        p(
            "Backend security/auth/credential handling, SQL query construction, secret-scanning "
            "history, dependency licensing, the 50-user beta roadmap, and the live order-execution "
            "path (backend/live/*). No fix has been applied yet - this is the findings list only.",
            "cover_subtitle",
        ),
        NextPageTemplate("Body"),
        PageBreak(),
    ]


def legal_story() -> list:
    content = section_header(
        "01", "Legal and compliance gaps",
        "Nothing found here is a code bug - these are missing decisions and documents "
        "that the beta plan needs before it reaches live external users.",
    )
    content.append(KeepTogether(legal_card(
        "HIGH",
        "SEBI algo-trading registration (effective 1 Aug 2025)",
        "SEBI's February 2025 circular requires retail algorithmic order flow placed "
        "through broker APIs above a per-broker order-rate threshold (commonly cited as "
        "10 orders/second) to be registered with the exchange via the broker. A platform "
        "that offers order execution to other retail users - not just its own account - is "
        "generally expected to be treated as an algo provider requiring exchange empanelment, "
        "not an individual \"tech-savvy retail\" user under the threshold.",
        "The roadmap's own Stage 4 (5 external live users) and Stage 5 (up to 50) would very "
        "likely put NRIAlgo outside the personal-use exemption. Operating unregistered live "
        "execution for other people's accounts carries direct regulatory exposure once real "
        "orders are placed for real users - independent of how well the code works.",
        "Get a specific legal opinion on algo-provider registration and broker empanelment "
        "before enabling Stage 4 (live users). Treat this as a rollout blocker, not a "
        "parallel workstream.",
    )))
    content.append(Spacer(1, 4 * mm))
    content.append(KeepTogether(legal_card(
        "HIGH",
        "No Terms of Service, Privacy Policy, or risk disclosure for beta users",
        "The README's disclaimers (\"Real execution is disabled by default,\" \"A successful "
        "build is not certification for live trading\") are written for you as the developer. "
        "There is no user-facing agreement describing trading risk, liability, data handling, "
        "or what the platform does and does not guarantee, for someone who is not you.",
        "Onboarding even 5 external users to connect a real broker account and place real "
        "money orders without an agreed risk disclosure and liability boundary is a direct "
        "personal liability exposure if something goes wrong with their trades or their data.",
        "Draft and require acceptance of a Terms of Service and a trading risk disclosure "
        "before any user beyond yourself connects a broker or places a live order - this can "
        "happen in parallel with the engineering workstreams, but must land before Stage 2.",
    )))
    content.append(PageBreak())
    content.extend(section_header(
        "01A", "Legal and compliance gaps",
        "Continuation: data protection and third-party data terms.",
    ))
    content.append(KeepTogether(legal_card(
        "MEDIUM",
        "India's DPDP Act 2023 (data protection) not addressed",
        "Once other users' broker credentials, PII, and financial data are stored - even "
        "encrypted at rest, as the current AES-256-GCM vault does correctly - operating as a "
        "data fiduciary for other people's personal data brings consent, breach-notification, "
        "and grievance-officer obligations that a single-user tool does not need.",
        "This becomes live the moment a second real person's data is stored, well before the "
        "live-trading question in the item above. It is a beta-launch blocker, not just a "
        "live-trading blocker.",
        "Add a short consent flow at signup and a documented data-handling/breach process "
        "before Stage 1 (the first 5 internal read-only users), not before Stage 4.",
    )))
    content.append(Spacer(1, 4 * mm))
    content.append(KeepTogether(legal_card(
        "LOW",
        "No note on NSE / broker data redistribution terms",
        "calculation_engine/market_insights.py and scripts/download-nse.py pull NSE reference "
        "data via the nsefin and bhavcopy PyPI packages, which wrap NSE's public website. "
        "Redistributing that data to other users is a common gray area in Indian fintech "
        "tooling and isn't addressed anywhere in the README.",
        "Low risk for internal analysis; becomes relevant the moment this data is shown "
        "inside a multi-user product rather than used for your own research.",
        "Add one line to the README noting the data is for internal research only and is "
        "not licensed for redistribution to beta users.",
    )))
    return content + [PageBreak()]


def code_story() -> list:
    content = section_header(
        "02", "Verified code defects — live order execution",
        "Confirmed by reading backend/live/* directly; each item below has a concrete "
        "file:line location, a trigger scenario, and a specific fix.",
    )
    content.append(KeepTogether(finding_card(
        "HIGH", "backend/live/kotak-live-manager.ts",
        "Cross-user account row can be silently corrupted",
        "kotak-live-manager.ts:182  ·  live_accounts.broker_binding is UNIQUE (database.ts:195)",
        "The upsert 'INSERT ... ON CONFLICT(broker_binding) DO UPDATE SET broker_id=...' has "
        "no user_id guard in its conflict clause.",
        "Two different app users' accountBinding strings collide (e.g. the same underlying "
        "broker account gets connected under a second login). The UPDATE then runs against "
        "the other user's existing row, overwriting its broker_id. That user's own lock check "
        "in execution.ts (account.broker_id !== this.brokerId) then fails and locks them out "
        "of their own live account with no visible cause.",
        "Scope the conflict/update to (broker_binding, user_id), e.g. add "
        "'WHERE live_accounts.user_id = EXCLUDED.user_id' to the DO UPDATE clause, and return "
        "a clear 409 on a genuine cross-user collision instead of upserting through it.",
    )))
    content.append(Spacer(1, 4 * mm))
    content.append(KeepTogether(finding_card(
        "MEDIUM", "backend/live/execution.ts",
        "Local validation failures misclassified as \"unknown\" outcome",
        "execution.ts:571-591  ·  dispatchStarted set before adapter.placeOrder validates the intent",
        "'dispatchStarted = true' is set immediately before calling adapter.placeOrder(), but "
        "placeOrder() runs its own synchronous validateIntent() before any network call "
        "(kotak-live-adapter.ts:133-134).",
        "The pre-flight validation throws before the broker was ever contacted - e.g. the "
        "instrument catalog reloaded with a changed lot size, or the short-sale guard at "
        "kotak-live-adapter.ts:125-129 trips. The order is marked 'unknown' instead of "
        "'blocked', which forces latchHalt(...) and a mandatory manual reconciliation for an "
        "event that had zero broker-side effect.",
        "Only set dispatchStarted to true after the adapter's own pre-flight validation "
        "passes and the network call actually begins, or have the adapter surface a distinct "
        "\"rejected before send\" error type that execution.ts maps to 'blocked'.",
    )))
    content.append(PageBreak())
    content.extend(section_header(
        "02A", "Verified code defects — live order execution",
        "Continuation: the one high-severity risk-control gap.",
    ))
    content.append(KeepTogether(finding_card(
        "HIGH", "backend/live/session-window.ts",
        "No trading-hours or session-window enforcement in the execution path",
        "session-window.ts (whole file)  ·  market-contracts.ts:28 regularMarketSessionOpen unused here",
        "session-window.ts only bounds app/broker permission expiry and calendar-day "
        "matching - it never checks time-of-day. The one function that does check real NSE "
        "market hours, regularMarketSessionOpen(), is imported only by market-data-routes.ts "
        "and is never called from execution.ts, risk.ts, kotak-live-manager.ts, or "
        "kotak-live-adapter.ts.",
        "arm()/preview()/submit() can run outside market hours or on a non-trading day as "
        "long as the broker API happens to respond with a healthy session and fresh quotes. "
        "The README states this Node layer is meant to be the canonical, independent "
        "enforcement point rather than trusting the broker to reject the order - right now "
        "it doesn't independently enforce this at all.",
        "Call regularMarketSessionOpen() (or an equivalent NSE calendar check) from the same "
        "place risk.ts enforces quantity/notional limits, and fail closed before arm/submit "
        "when the market is closed. Close this before Stage 4 (live users) of the rollout.",
    )))
    content.append(Spacer(1, 5 * mm))
    content.append(callout(
        "Not found",
        "No idempotency, locking, or numeric-precision bugs were found in this path. "
        "Intent-key deduplication, the account-row FOR UPDATE locking, and the paise-based "
        "integer arithmetic were all internally consistent on direct reading.",
        GREEN_TINT, GREEN,
    ))
    return content + [PageBreak()]


def priority_story() -> list:
    content = section_header(
        "03", "Suggested order of work",
        "Ranked by what blocks the next rollout stage in the existing beta roadmap, not by "
        "how the items were discovered.",
    )
    rows = [
        [p("Before", "table_head"), p("Item", "table_head"), p("Type", "table_head"), p("Severity", "table_head")],
        [p("Any beta user", "table_cell_bold"), p("DPDP Act consent + data-handling process", "table_cell"), p("Legal", "table_cell"), p("MEDIUM", "table_cell")],
        [p("Stage 2 (10 ext. users)", "table_cell_bold"), p("Terms of Service + risk disclosure", "table_cell"), p("Legal", "table_cell"), p("HIGH", "table_cell")],
        [p("Stage 4 (5 live users)", "table_cell_bold"), p("SEBI algo-provider registration review", "table_cell"), p("Legal", "table_cell"), p("HIGH", "table_cell")],
        [p("Stage 4 (5 live users)", "table_cell_bold"), p("Trading-hours check missing in execution path", "table_cell"), p("Code", "table_cell"), p("HIGH", "table_cell")],
        [p("Stage 4 (5 live users)", "table_cell_bold"), p("Cross-user live_accounts upsert collision", "table_cell"), p("Code", "table_cell"), p("HIGH", "table_cell")],
        [p("Stage 4 (5 live users)", "table_cell_bold"), p("Local-failure misclassified as unknown outcome", "table_cell"), p("Code", "table_cell"), p("MEDIUM", "table_cell")],
        [p("Public repo / redistribution", "table_cell_bold"), p("README note on NSE data licensing", "table_cell"), p("Legal", "table_cell"), p("LOW", "table_cell")],
    ]
    table = Table(rows, colWidths=[42 * mm, 78 * mm, 26 * mm, 25 * mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, PANEL]),
        ("GRID", (0, 0), (-1, -1), 0.5, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    content.extend([table, Spacer(1, 7 * mm)])
    content.append(callout(
        "Note",
        "This document is an engineering review, not legal advice. The legal items need "
        "sign-off from a qualified advisor before Stage 4 of the existing rollout plan; the "
        "code items need a fix and a regression test before the same milestone.",
        AMBER_TINT, AMBER,
    ))
    return content


def build_pdf() -> Path:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    story = []
    story.extend(cover_story())
    story.extend(legal_story())
    story.extend(code_story())
    story.extend(priority_story())
    document = make_document()
    document.build(story)
    return OUTPUT_PATH.resolve()


if __name__ == "__main__":
    print(build_pdf())
