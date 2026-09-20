"""Generate the NRIAlgo reliable 50-user beta roadmap as a polished PDF.

The document is intentionally implementation-oriented: each workstream has a
clear outcome, concrete actions, and an exit gate so it can be used for both
engineering planning and stakeholder review.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase import pdfmetrics
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


OUTPUT_PATH = Path("output/pdf/nrialgo-50-user-beta-roadmap.pdf")
PAGE_WIDTH, PAGE_HEIGHT = A4

NAVY = colors.HexColor("#0F2747")
BLUE = colors.HexColor("#2563EB")
SKY = colors.HexColor("#EAF2FF")
CYAN = colors.HexColor("#0EA5E9")
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


def register_fonts() -> tuple[str, str, str]:
    """Register a modern sans-serif family when available, with safe fallbacks."""

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
            pdfmetrics.registerFont(TTFont("NRIIitalic", italic))
            return "NRIRegular", "NRIBold", "NRIIitalic"
    return "Helvetica", "Helvetica-Bold", "Helvetica-Oblique"


FONT, FONT_BOLD, FONT_ITALIC = register_fonts()


def build_styles() -> dict[str, ParagraphStyle]:
    """Create the document's reusable typography system."""

    base = getSampleStyleSheet()
    return {
        "cover_kicker": ParagraphStyle(
            "CoverKicker",
            parent=base["Normal"],
            fontName=FONT_BOLD,
            fontSize=10,
            leading=13,
            textColor=colors.HexColor("#A9CBFF"),
            spaceAfter=8,
            tracking=1.4,
        ),
        "cover_title": ParagraphStyle(
            "CoverTitle",
            parent=base["Title"],
            fontName=FONT_BOLD,
            fontSize=32,
            leading=37,
            textColor=WHITE,
            spaceAfter=15,
        ),
        "cover_subtitle": ParagraphStyle(
            "CoverSubtitle",
            parent=base["Normal"],
            fontName=FONT,
            fontSize=14,
            leading=20,
            textColor=colors.HexColor("#DCE9FF"),
            spaceAfter=22,
        ),
        "title": ParagraphStyle(
            "SectionTitle",
            parent=base["Heading1"],
            fontName=FONT_BOLD,
            fontSize=22,
            leading=27,
            textColor=NAVY,
            spaceAfter=7,
        ),
        "subtitle": ParagraphStyle(
            "SectionSubtitle",
            parent=base["Normal"],
            fontName=FONT,
            fontSize=10.5,
            leading=15,
            textColor=SLATE,
            spaceAfter=14,
        ),
        "h2": ParagraphStyle(
            "H2",
            parent=base["Heading2"],
            fontName=FONT_BOLD,
            fontSize=14,
            leading=18,
            textColor=NAVY,
            spaceBefore=4,
            spaceAfter=6,
        ),
        "h3": ParagraphStyle(
            "H3",
            parent=base["Heading3"],
            fontName=FONT_BOLD,
            fontSize=11,
            leading=14,
            textColor=INK,
            spaceAfter=3,
        ),
        "body": ParagraphStyle(
            "Body",
            parent=base["BodyText"],
            fontName=FONT,
            fontSize=9.2,
            leading=13.2,
            textColor=INK,
            spaceAfter=6,
        ),
        "body_small": ParagraphStyle(
            "BodySmall",
            parent=base["BodyText"],
            fontName=FONT,
            fontSize=8.1,
            leading=11.2,
            textColor=INK,
            spaceAfter=3,
        ),
        "body_small_light": ParagraphStyle(
            "BodySmallLight",
            parent=base["BodyText"],
            fontName=FONT,
            fontSize=8.1,
            leading=11.2,
            textColor=colors.HexColor("#DCE9FF"),
            spaceAfter=3,
        ),
        "bullet": ParagraphStyle(
            "Bullet",
            parent=base["BodyText"],
            fontName=FONT,
            fontSize=8.8,
            leading=12.3,
            leftIndent=11,
            firstLineIndent=-7,
            bulletIndent=0,
            textColor=INK,
            spaceAfter=3,
        ),
        "metric": ParagraphStyle(
            "Metric",
            parent=base["Normal"],
            fontName=FONT_BOLD,
            fontSize=17,
            leading=19,
            textColor=BLUE,
            alignment=TA_CENTER,
        ),
        "metric_label": ParagraphStyle(
            "MetricLabel",
            parent=base["Normal"],
            fontName=FONT,
            fontSize=7.5,
            leading=10,
            textColor=SLATE,
            alignment=TA_CENTER,
        ),
        "table_head": ParagraphStyle(
            "TableHead",
            parent=base["Normal"],
            fontName=FONT_BOLD,
            fontSize=7.8,
            leading=10,
            textColor=WHITE,
        ),
        "table_cell": ParagraphStyle(
            "TableCell",
            parent=base["Normal"],
            fontName=FONT,
            fontSize=7.4,
            leading=10,
            textColor=INK,
        ),
        "table_cell_bold": ParagraphStyle(
            "TableCellBold",
            parent=base["Normal"],
            fontName=FONT_BOLD,
            fontSize=7.4,
            leading=10,
            textColor=INK,
        ),
        "callout": ParagraphStyle(
            "Callout",
            parent=base["Normal"],
            fontName=FONT_BOLD,
            fontSize=10,
            leading=14,
            textColor=NAVY,
        ),
        "tiny": ParagraphStyle(
            "Tiny",
            parent=base["Normal"],
            fontName=FONT,
            fontSize=6.8,
            leading=8.5,
            textColor=MUTED,
        ),
    }


STYLES = build_styles()


def p(text: str, style: str = "body") -> Paragraph:
    """Create a paragraph from text using a named document style."""

    return Paragraph(text, STYLES[style])


def bullet(text: str) -> Paragraph:
    """Create a compact bullet item with consistent alignment."""

    return Paragraph(f"- {text}", STYLES["bullet"])


def section_header(number: str, title: str, subtitle: str) -> list:
    """Return a consistent section header block for interior pages."""

    badge = Table(
        [[p(number, "table_head")]],
        colWidths=[18 * mm],
        rowHeights=[8 * mm],
    )
    badge.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), BLUE),
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("BOX", (0, 0), (-1, -1), 0, BLUE),
            ]
        )
    )
    heading = Table(
        [[badge, [p(title, "title"), p(subtitle, "subtitle")]]],
        colWidths=[24 * mm, 147 * mm],
    )
    heading.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (0, 0), 6),
                ("RIGHTPADDING", (1, 0), (1, 0), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ]
        )
    )
    return [heading, Spacer(1, 3 * mm)]


def callout(title: str, body: str, tint=SKY, accent=BLUE) -> Table:
    """Create a bordered emphasis panel for a key decision or exit gate."""

    table = Table(
        [[[p(title, "h3"), p(body, "body_small")]]],
        colWidths=[171 * mm],
    )
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), tint),
                ("LINEBEFORE", (0, 0), (0, -1), 4, accent),
                ("BOX", (0, 0), (-1, -1), 0.5, colors.Color(accent.red, accent.green, accent.blue, alpha=0.3)),
                ("LEFTPADDING", (0, 0), (-1, -1), 10),
                ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
            ]
        )
    )
    return table


def workstream_card(number: int, title: str, outcome: str, actions: list[str], gate: str) -> Table:
    """Create a self-contained workstream card with actions and a release gate."""

    left = Table(
        [[p(f"{number:02d}", "metric")], [p("STREAM", "metric_label")]],
        colWidths=[22 * mm],
    )
    left.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), SKY),
                ("BOX", (0, 0), (-1, -1), 0.5, LINE),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    action_block = [p(f"<b>{title}</b>", "h2"), p(outcome, "body_small")]
    action_block.extend(bullet(item) for item in actions)
    action_block.append(Spacer(1, 2))
    action_block.append(p(f"<font color='#0F9F6E'><b>Exit gate:</b></font> {gate}", "body_small"))
    table = Table([[left, action_block]], colWidths=[27 * mm, 144 * mm])
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), WHITE),
                ("BOX", (0, 0), (-1, -1), 0.7, LINE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (0, 0), 7),
                ("RIGHTPADDING", (0, 0), (0, 0), 7),
                ("TOPPADDING", (0, 0), (0, 0), 8),
                ("BOTTOMPADDING", (0, 0), (0, 0), 8),
                ("LEFTPADDING", (1, 0), (1, 0), 10),
                ("RIGHTPADDING", (1, 0), (1, 0), 10),
                ("TOPPADDING", (1, 0), (1, 0), 8),
                ("BOTTOMPADDING", (1, 0), (1, 0), 8),
            ]
        )
    )
    return table


def architecture_diagram() -> Table:
    """Build a simple broker-agnostic architecture flow using vector tables."""

    def box(title: str, detail: str, color) -> Table:
        result = Table([[p(title, "h3")], [p(detail, "tiny")]], colWidths=[31 * mm])
        result.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, -1), color),
                    ("BOX", (0, 0), (-1, -1), 0.7, LINE),
                    ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 5),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                    ("TOPPADDING", (0, 0), (-1, -1), 7),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
                ]
            )
        )
        return result

    arrow = p("&#8594;", "h2")
    diagram = Table(
        [[
            box("React", "Screens, charts, user intent", SKY),
            arrow,
            box("Node.js", "Auth, live data, execution authority", GREEN_TINT),
            arrow,
            box("PostgreSQL", "Durable users, jobs, orders", AMBER_TINT),
            arrow,
            box("Python", "Backtests, payoff, analytics", RED_TINT),
        ]],
        colWidths=[34 * mm, 7 * mm, 38 * mm, 7 * mm, 38 * mm, 7 * mm, 40 * mm],
    )
    diagram.setStyle(
        TableStyle(
            [
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ]
        )
    )
    return diagram


def page_background(canvas, doc) -> None:
    """Draw the standard page frame, header, and footer for interior pages."""

    canvas.saveState()
    canvas.setFillColor(PANEL)
    canvas.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, stroke=0, fill=1)
    canvas.setFillColor(WHITE)
    canvas.roundRect(14 * mm, 14 * mm, PAGE_WIDTH - 28 * mm, PAGE_HEIGHT - 28 * mm, 5 * mm, stroke=0, fill=1)
    canvas.setFillColor(NAVY)
    canvas.rect(14 * mm, PAGE_HEIGHT - 22 * mm, PAGE_WIDTH - 28 * mm, 8 * mm, stroke=0, fill=1)
    canvas.setFillColor(WHITE)
    canvas.setFont(FONT_BOLD, 8)
    canvas.drawString(20 * mm, PAGE_HEIGHT - 19 * mm, "NRIALGO  /  RELIABLE 50-USER BETA")
    canvas.setFillColor(MUTED)
    canvas.setFont(FONT, 7)
    canvas.drawString(20 * mm, 9 * mm, "Engineering roadmap  |  Internal planning document")
    canvas.drawRightString(PAGE_WIDTH - 20 * mm, 9 * mm, f"{doc.page}")
    canvas.restoreState()


def cover_background(canvas, doc) -> None:
    """Draw the dark cover with a geometric roadmap motif."""

    canvas.saveState()
    canvas.setFillColor(NAVY)
    canvas.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, stroke=0, fill=1)
    canvas.setFillColor(colors.HexColor("#123A6C"))
    canvas.circle(PAGE_WIDTH + 8 * mm, PAGE_HEIGHT - 35 * mm, 54 * mm, stroke=0, fill=1)
    canvas.setFillColor(colors.HexColor("#184C86"))
    canvas.circle(PAGE_WIDTH - 7 * mm, PAGE_HEIGHT - 25 * mm, 31 * mm, stroke=0, fill=1)
    canvas.setStrokeColor(colors.HexColor("#6EA6FF"))
    canvas.setLineWidth(2)
    points = [
        (25 * mm, 64 * mm),
        (58 * mm, 90 * mm),
        (92 * mm, 81 * mm),
        (125 * mm, 116 * mm),
        (158 * mm, 106 * mm),
        (184 * mm, 139 * mm),
    ]
    for start, end in zip(points, points[1:]):
        canvas.line(start[0], start[1], end[0], end[1])
    for index, (x, y) in enumerate(points, start=1):
        canvas.setFillColor(GREEN if index == len(points) else BLUE)
        canvas.circle(x, y, 4.2 * mm, stroke=0, fill=1)
        canvas.setFillColor(WHITE)
        canvas.setFont(FONT_BOLD, 7)
        canvas.drawCentredString(x, y - 2.3, str(index))
    canvas.setFillColor(colors.HexColor("#98BCEB"))
    canvas.setFont(FONT, 7)
    canvas.drawString(20 * mm, 14 * mm, "Prepared 19 September 2026  |  NRIAlgo Engineering")
    canvas.restoreState()


def make_document() -> BaseDocTemplate:
    """Create the PDF document with separate cover and interior templates."""

    doc = BaseDocTemplate(
        str(OUTPUT_PATH),
        pagesize=A4,
        leftMargin=20 * mm,
        rightMargin=20 * mm,
        topMargin=29 * mm,
        bottomMargin=18 * mm,
        title="NRIAlgo Reliable 50-User Beta Roadmap",
        author="NRIAlgo Engineering",
        subject="Production-readiness roadmap for a reliable 50-user beta",
    )
    cover_frame = Frame(20 * mm, 20 * mm, PAGE_WIDTH - 40 * mm, PAGE_HEIGHT - 40 * mm, id="cover", showBoundary=0)
    body_frame = Frame(20 * mm, 18 * mm, PAGE_WIDTH - 40 * mm, PAGE_HEIGHT - 45 * mm, id="body", showBoundary=0)
    doc.addPageTemplates(
        [
            PageTemplate(id="Cover", frames=[cover_frame], onPage=cover_background),
            PageTemplate(id="Body", frames=[body_frame], onPage=page_background),
        ]
    )
    return doc


def cover_story() -> list:
    """Build the cover page and its executive positioning."""

    return [
        Spacer(1, 35 * mm),
        p("ENGINEERING ROADMAP", "cover_kicker"),
        p("Reliable 50-User<br/>Beta Plan", "cover_title"),
        p("Strengthen the existing NRIAlgo platform for a safe, observable, invite-only beta - without a rewrite.", "cover_subtitle"),
        Spacer(1, 8 * mm),
        Table(
            [[
                [p("MODULAR MONOLITH", "table_head"), p("Keep React + Node.js + PostgreSQL + Python workers.", "body_small_light")],
                [p("SAFETY FIRST", "table_head"), p("Read-only, paper, and live access expand through explicit gates.", "body_small_light")],
                [p("MEASURED SCALE", "table_head"), p("Design and test for 50 users before planning for 10,000.", "body_small_light")],
            ]],
            colWidths=[55 * mm, 55 * mm, 55 * mm],
            style=TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#17385F")),
                    ("BOX", (0, 0), (-1, -1), 0.7, colors.HexColor("#315B89")),
                    ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#315B89")),
                    ("TEXTCOLOR", (0, 0), (-1, -1), WHITE),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 9),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 9),
                    ("TOPPADDING", (0, 0), (-1, -1), 9),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
                ]
            ),
        ),
        Spacer(1, 33 * mm),
        p("NORTH STAR", "cover_kicker"),
        p("A beta user can connect a broker, see accurate account and market state, run a calculation, and place or cancel an approved live order - with every failure visible and recoverable.", "cover_subtitle"),
        NextPageTemplate("Body"),
        PageBreak(),
    ]


def overview_story() -> list:
    """Build the scope, capacity, and architecture overview page."""

    content = section_header(
        "01",
        "Beta definition and architecture",
        "A practical target for the next release: reliable enough to learn from real users, small enough to operate safely.",
    )
    metrics = [
        ("50", "registered users"),
        ("20", "concurrent sessions"),
        ("10-20", "broker connections"),
        ("10", "simultaneous feeds"),
        ("2-4", "calculation jobs"),
    ]
    metric_table = Table(
        [[[p(value, "metric"), p(label, "metric_label")] for value, label in metrics]],
        colWidths=[34.2 * mm] * 5,
    )
    metric_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), PANEL),
                ("BOX", (0, 0), (-1, -1), 0.7, LINE),
                ("INNERGRID", (0, 0), (-1, -1), 0.5, LINE),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
            ]
        )
    )
    content.extend([metric_table, Spacer(1, 7 * mm), p("Broker-agnostic modular monolith", "h2"), architecture_diagram(), Spacer(1, 4 * mm)])
    boundaries = [
        [p("Layer", "table_head"), p("Owns", "table_head"), p("Must not own", "table_head")],
        [p("React", "table_cell_bold"), p("Screens, charts, forms, interaction state", "table_cell"), p("Broker credentials or order authority", "table_cell")],
        [p("Node.js", "table_cell_bold"), p("Authentication, broker sessions, live data, execution risk", "table_cell"), p("Heavy historical calculations", "table_cell")],
        [p("Python", "table_cell_bold"), p("Historical processing, Greeks, payoff, backtests", "table_cell"), p("Broker secrets or final live-order approval", "table_cell")],
        [p("PostgreSQL / Parquet", "table_cell_bold"), p("Durable transactions / immutable history", "table_cell"), p("Duplicate copies of the same market dataset", "table_cell")],
    ]
    boundary_table = Table(boundaries, colWidths=[37 * mm, 68 * mm, 66 * mm], repeatRows=1)
    boundary_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), NAVY),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, PANEL]),
                ("GRID", (0, 0), (-1, -1), 0.5, LINE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 7),
                ("RIGHTPADDING", (0, 0), (-1, -1), 7),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    content.extend([boundary_table, Spacer(1, 5 * mm), callout("Core decision", "Keep the current architecture. Strengthen contracts, capacity controls, recovery paths, and evidence. Do not introduce Kubernetes or split the application into microservices for this beta.")])
    return content + [PageBreak()]


def workstreams_story() -> list:
    """Build the two pages containing the ten production-readiness workstreams."""

    first = section_header("02", "Production-readiness workstreams", "Ten bounded workstreams convert the current application into an operable beta.")
    cards = [
        (1, "Make the repository green", "Create a trustworthy release signal before adding more product surface.", ["Fix lint and restore automated tests.", "Add Kotak and Zerodha broker fixtures.", "Cover P&L, pledged holdings, Greeks, payoff, backtests, kill switch, and core browser journeys.", "Require lint, tests, and production build in CI."], "One offline command validates the entire repository."),
        (2, "Make capacity explicit", "Turn the 50-user objective into measurable load-test scenarios.", ["Model 20 signed-in users, 10-20 broker connections, 10 live feeds, and 2-4 calculation jobs.", "Use production-shaped datasets and realistic reconnect patterns.", "Record latency, failure rate, memory, socket count, and database pressure."], "Capacity report passes agreed service thresholds without manual intervention."),
        (3, "Harden broker connectivity", "Replace broker-specific assumptions with bounded, recoverable broker sessions.", ["Use configurable connection limits and per-user/global request budgets.", "Expire idle sessions and release subscriptions deterministically.", "Persist encrypted recovery state in PostgreSQL.", "Expose connecting, active, stale, disconnected, and failed states.", "Add provider-specific circuit breakers behind a broker-agnostic contract."], "A broker outage degrades clearly and cannot exhaust the API."),
        (4, "Scale calculation workers", "Run historical and analytical work without blocking the API.", ["Run 2-4 Python workers with durable PostgreSQL jobs.", "Replace the global lease with configurable concurrent leases.", "Add progress, cancellation, stale-job fencing, and wall-time limits.", "Route Greeks, payoff, and backtests through versioned strategy contracts."], "Workers can crash or restart without losing or duplicating a job."),
        (5, "Tune the data layer", "Keep transactional data durable and historical data compact.", ["Start with a measured database pool of roughly 10-15 connections.", "Add indexes only from slow-query evidence.", "Paginate unbounded lists and capture query/pool-wait telemetry.", "Keep immutable history in Parquet and transactional state in PostgreSQL.", "Prove a backup restore before beta."], "Recovery test succeeds and peak pool wait remains within the target."),
    ]
    for index, card in enumerate(cards[:3]):
        first.append(KeepTogether(workstream_card(*card)))
        if index < 2:
            first.append(Spacer(1, 4 * mm))
    first.append(PageBreak())

    first.extend(section_header("02A", "Production-readiness workstreams", "Continuation: computation and data foundations."))
    for index, card in enumerate(cards[3:]):
        first.append(KeepTogether(workstream_card(*card)))
        if index < 1:
            first.append(Spacer(1, 4 * mm))
    first.append(PageBreak())

    second = section_header("03", "Production-readiness workstreams", "Operational visibility and controlled rollout complete the beta foundation.")
    cards_2 = [
        (6, "Make dashboards efficient", "Keep account truth explicit while streaming only the prices that affect visible state.", ["Refresh account reports explicitly; stream only price changes.", "Use a shared tick store for open-position P&L.", "Subscribe only to visible or open instruments and release after the browser lease ends.", "Show stale timestamps and reconnect state; avoid per-browser broker polling."], "Ten dashboards stay synchronized without multiplying broker requests."),
        (7, "Add observability", "Detect failures before users have to report them.", ["Measure HTTP latency, errors, database waits, broker latency, rate limits, WebSocket staleness, worker queues, and process health.", "Track execution, reconciliation, and unresolved cancellation outcomes.", "Use correlation IDs and safe metadata only - never credentials or raw sensitive payloads."], "One dashboard and one incident trail explain every critical failure."),
        (8, "Secure live access", "Treat live execution as a privileged capability, not a default mode.", ["Run an invite-only beta with MFA for live users.", "Keep global live trading off by default and approve users individually.", "Apply conservative per-user limits and rotate previously exposed secrets.", "Separate staging and production credentials; add dependency, container, and secret scanning."], "No live user can bypass approval, limits, or audit logging."),
        (9, "Test failure modes", "Prove unknown outcomes are surfaced instead of fabricated as zero, empty, or successful.", ["Exercise token expiry, duplicate submission, order timeouts, stale feeds, database restarts, worker crashes, and concurrent account sessions.", "Verify kill switch behavior, partial broker data, pledged/T1/MTF holdings, and cancellation reconciliation."], "Every injected failure has an explicit user state and recovery path."),
        (10, "Roll out in gates", "Expand risk only after the previous stage is stable.", ["5 internal read-only users.", "10 external users on historical data and dashboards.", "20 users on paper/replay.", "5 live users with small limits.", "Expand toward 50 only after two stable weeks per stage."], "The next cohort opens only when reliability and usage gates pass."),
    ]
    for index, card in enumerate(cards_2[:3]):
        second.append(KeepTogether(workstream_card(*card)))
        if index < 2:
            second.append(Spacer(1, 4 * mm))
    second.append(PageBreak())
    second.extend(section_header("03A", "Production-readiness workstreams", "Continuation: failure discipline and controlled rollout."))
    for index, card in enumerate(cards_2[3:]):
        second.append(KeepTogether(workstream_card(*card)))
        if index < 1:
            second.append(Spacer(1, 4 * mm))
    return first + second + [PageBreak()]


def failure_matrix_story() -> list:
    """Build the operational failure matrix and evidence requirements."""

    content = section_header("04", "Failure testing and release evidence", "The beta is ready only when critical failures are visible, bounded, and recoverable.")
    rows = [
        [p("Scenario", "table_head"), p("Expected product behavior", "table_head"), p("Evidence", "table_head")],
        [p("API restarts during broker session", "table_cell_bold"), p("Connection becomes reconnecting/stale; recovery is bounded and duplicate subscriptions are prevented.", "table_cell"), p("Restart test, socket and subscription counts", "table_cell")],
        [p("Broker token expires", "table_cell_bold"), p("Trading and account refresh lock; user sees reconnect action; no silent fallback.", "table_cell"), p("Fixture test and browser flow", "table_cell")],
        [p("Order times out after submit", "table_cell_bold"), p("Outcome is marked unknown and reconciled before any retry.", "table_cell"), p("Idempotency and reconciliation test", "table_cell")],
        [p("Duplicate order request", "table_cell_bold"), p("Same durable intent is returned; broker receives at most one submission.", "table_cell"), p("Concurrent submission test", "table_cell")],
        [p("WebSocket disconnects", "table_cell_bold"), p("Prices show stale age, P&L stops claiming freshness, and reconnect is visible.", "table_cell"), p("Feed interruption browser test", "table_cell")],
        [p("PostgreSQL restarts", "table_cell_bold"), p("Requests fail safely, workers stop leasing, and recovery does not duplicate jobs or orders.", "table_cell"), p("Database chaos test", "table_cell")],
        [p("Python worker crashes", "table_cell_bold"), p("Lease expires, job is safely reclaimed or fails visibly, and progress does not lie.", "table_cell"), p("Worker kill and reclaim test", "table_cell")],
        [p("Two sessions use one account", "table_cell_bold"), p("Connection ownership and subscriptions remain consistent; user sees current state.", "table_cell"), p("Multi-session test", "table_cell")],
        [p("Kill switch invoked", "table_cell_bold"), p("Pending cancellations are attempted, unresolved orders remain visible, and final state is reconciled.", "table_cell"), p("Broker fixture plus audit record", "table_cell")],
        [p("Partial or malformed broker data", "table_cell_bold"), p("Affected fields show unavailable/stale; zero is used only when the broker explicitly reports zero.", "table_cell"), p("Contract and parsing tests", "table_cell")],
    ]
    table = Table(rows, colWidths=[42 * mm, 82 * mm, 47 * mm], repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), NAVY),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, PANEL]),
                ("GRID", (0, 0), (-1, -1), 0.5, LINE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    content.extend([table, Spacer(1, 6 * mm), callout("Non-negotiable", "The application must never fabricate a zero, empty result, fresh price, or successful order outcome when the upstream state is unknown.", RED_TINT, RED)])
    return content + [PageBreak()]


def rollout_story() -> list:
    """Build the phased rollout, decision gates, and product-value scorecard."""

    content = section_header("05", "Controlled beta rollout", "Each stage increases user value and operational risk only after two stable weeks.")
    phases = [
        ("1", "Internal read-only", "5 users", "Broker connection, account data, option chain, dashboard accuracy", "No critical data-integrity defect; connection success at target"),
        ("2", "External research", "10 users", "Historical data, builder, simulator, backtests", "Calculation completion and usability targets pass"),
        ("3", "Paper and replay", "20 users", "End-to-end strategy workflow without real orders", "No lost jobs; P&L and replay remain reproducible"),
        ("4", "Restricted live", "5 approved users", "Small-limit live execution with kill switch", "No unresolved execution/reconciliation incident"),
        ("5", "Expanded beta", "Up to 50", "Broader access within measured limits", "Two stable weeks and support load within capacity"),
    ]
    phase_rows = [[p("Stage", "table_head"), p("Cohort", "table_head"), p("Scope", "table_head"), p("Promotion gate", "table_head")]]
    for stage, cohort, users, scope, gate in phases:
        phase_rows.append([
            p(stage, "table_cell_bold"),
            p(f"<b>{cohort}</b><br/>{users}", "table_cell"),
            p(scope, "table_cell"),
            p(gate, "table_cell"),
        ])
    phase_table = Table(phase_rows, colWidths=[15 * mm, 41 * mm, 61 * mm, 54 * mm], repeatRows=1)
    phase_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), NAVY),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, PANEL]),
                ("GRID", (0, 0), (-1, -1), 0.5, LINE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("ALIGN", (0, 1), (0, -1), "CENTER"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
            ]
        )
    )
    content.extend([phase_table, Spacer(1, 7 * mm), p("Scorecard", "h2")])
    score_rows = [
        [p("Reliability", "table_head"), p("Safety", "table_head"), p("User value", "table_head")],
        [
            [bullet("Broker connection success"), bullet("Dashboard load time"), bullet("Stale feed incidents"), bullet("Calculation completion")],
            [bullet("Reconciliation failures"), bullet("Unknown order outcomes"), bullet("Kill-switch completion"), bullet("Limit or permission violations")],
            [bullet("Weekly active users"), bullet("Repeat usage / retention"), bullet("Screens and workflows used"), bullet("Decisions improved or errors prevented")],
        ],
    ]
    score_table = Table(score_rows, colWidths=[57 * mm] * 3)
    score_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), BLUE),
                ("BACKGROUND", (0, 1), (-1, -1), PANEL),
                ("GRID", (0, 0), (-1, -1), 0.5, LINE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
            ]
        )
    )
    content.extend([score_table, Spacer(1, 6 * mm), callout("Promotion rule", "No cohort expands because a date arrived. Expansion requires evidence that reliability, safety, and product-value gates all passed for the prior stage.", GREEN_TINT, GREEN)])
    return content + [PageBreak()]


def close_story() -> list:
    """Build the final priorities page and immediate milestone sequence."""

    content = section_header("06", "Immediate milestone and guardrails", "Focus the next delivery cycle on foundations that make every later feature safer and faster.")
    sequence = [
        ("1", "Green repository", "Lint, tests, production build, and repeatable offline validation."),
        ("2", "Automated contracts", "Broker fixtures plus calculation and critical browser regression coverage."),
        ("3", "Configurable capacity", "Broker limits, budgets, cleanup, and explicit connection states."),
        ("4", "Multiple Python workers", "Durable jobs, leases, progress, cancellation, and failure recovery."),
        ("5", "Operational visibility", "Metrics, structured logs, correlation IDs, and incident runbooks."),
        ("6", "Five-user read-only beta", "Operate the smallest real cohort and close evidence gaps."),
    ]
    seq_rows = []
    for number, title, detail in sequence:
        number_cell = Table([[p(number, "table_head")]], colWidths=[10 * mm], rowHeights=[10 * mm])
        number_cell.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), BLUE), ("ALIGN", (0, 0), (-1, -1), "CENTER"), ("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
        seq_rows.append([number_cell, [p(title, "h3"), p(detail, "body_small")]])
    seq_table = Table(seq_rows, colWidths=[17 * mm, 154 * mm])
    seq_table.setStyle(
        TableStyle(
            [
                ("ROWBACKGROUNDS", (0, 0), (-1, -1), [WHITE, PANEL]),
                ("BOX", (0, 0), (-1, -1), 0.7, LINE),
                ("INNERGRID", (0, 0), (-1, -1), 0.4, LINE),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (0, -1), 4),
                ("RIGHTPADDING", (0, 0), (0, -1), 4),
                ("LEFTPADDING", (1, 0), (1, -1), 9),
                ("RIGHTPADDING", (1, 0), (1, -1), 9),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
            ]
        )
    )
    content.extend([seq_table, Spacer(1, 8 * mm), p("Do not do yet", "h2")])
    not_yet = Table(
        [[
            [p("<font color='#C2413A'><b>NO REWRITE</b></font>", "body_small"), p("Preserve working product knowledge and harden contracts incrementally.", "body_small")],
            [p("<font color='#C2413A'><b>NO PREMATURE SCALE</b></font>", "body_small"), p("No Kubernetes, microservice split, read replicas, or 10,000-user infrastructure yet.", "body_small")],
            [p("<font color='#C2413A'><b>NO UNSAFE AUTOMATION</b></font>", "body_small"), p("Never retry unknown live orders automatically or enable live access for every user.", "body_small")],
        ]],
        colWidths=[57 * mm] * 3,
    )
    not_yet.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), RED_TINT),
                ("BOX", (0, 0), (-1, -1), 0.7, colors.HexColor("#F2C7C3")),
                ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#F2C7C3")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 9),
                ("RIGHTPADDING", (0, 0), (-1, -1), 9),
                ("TOPPADDING", (0, 0), (-1, -1), 9),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
                ("TEXTCOLOR", (0, 0), (-1, -1), INK),
            ]
        )
    )
    content.extend([not_yet, Spacer(1, 9 * mm), callout("Definition of ready", "NRIAlgo is ready for the 50-user beta when the repository is green, capacity is measured, failures are explicit, live access is gated, recovery is proven, and the five-user read-only cohort has completed two stable weeks.", GREEN_TINT, GREEN), Spacer(1, 10 * mm), p("Build confidence before scale. Measure value before expansion.", "title")])
    return content


def build_pdf() -> Path:
    """Assemble and write the complete roadmap PDF."""

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    story = []
    story.extend(cover_story())
    story.extend(overview_story())
    story.extend(workstreams_story())
    story.extend(failure_matrix_story())
    story.extend(rollout_story())
    story.extend(close_story())
    document = make_document()
    document.build(story)
    return OUTPUT_PATH.resolve()


if __name__ == "__main__":
    print(build_pdf())
