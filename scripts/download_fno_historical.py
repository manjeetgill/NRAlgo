#!/usr/bin/env python3
"""Download and normalize official NSE F&O end-of-day option archives.

This operator tool reads public NSE archive files at a conservative rate. It
does not impersonate a browser, bypass access controls, or derive missing option
prices. Each exchange day is stored independently with checksums so an
interrupted backfill can resume without appending duplicates.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import importlib
import io
import json
import math
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request
import zipfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Iterable

ARCHIVE_HOST = "https://nsearchives.nseindia.com"
UDIFF_START = date(2024, 7, 8)
NORMALIZER_VERSION = 4
MAX_ARCHIVE_BYTES = 30 * 1024 * 1024
MAX_CSV_BYTES = 160 * 1024 * 1024
DEFAULT_SYMBOLS = ("NIFTY", "BANKNIFTY")
NORMALIZED_FIELDS = (
    "day",
    "underlying",
    "expiry_date",
    "right",
    "strike_price",
    "open",
    "high",
    "low",
    "close",
    "settlement",
    "volume",
    "open_interest",
    "change_open_interest",
    "lot_size",
    "underlying_price",
    "source",
)
LEGACY_REQUIRED = {
    "INSTRUMENT",
    "SYMBOL",
    "EXPIRY_DT",
    "STRIKE_PR",
    "OPTION_TYP",
    "OPEN",
    "HIGH",
    "LOW",
    "CLOSE",
    "SETTLE_PR",
    "CONTRACTS",
    "OPEN_INT",
    "CHG_IN_OI",
    "TIMESTAMP",
}
UDIFF_REQUIRED = {
    "TradDt",
    "FinInstrmTp",
    "TckrSymb",
    "XpryDt",
    "StrkPric",
    "OptnTp",
    "OpnPric",
    "HghPric",
    "LwPric",
    "ClsPric",
    "SttlmPric",
    "OpnIntrst",
    "ChngInOpnIntrst",
    "TtlTradgVol",
    "NewBrdLotQty",
    "UndrlygPric",
}


class ArchiveValidationError(ValueError):
    """Raised when an archive cannot be trusted as the requested NSE report."""


class ArchiveUnavailableError(FileNotFoundError):
    """Raised for a genuine missing exchange day such as a holiday."""


class _BhavcopyResponse:
    """Minimal requests response that keeps the package on prevalidated bytes."""

    def __init__(self, payload: bytes):
        self.content = payload

    def raise_for_status(self) -> None:
        """The repository downloader has already handled the HTTP response."""


class _BhavcopySession:
    """Provide one validated archive to bhavcopy without a second network call."""

    def __init__(self, payload: bytes):
        self.payload = payload
        self.headers: dict[str, str] = {}

    def __enter__(self) -> "_BhavcopySession":
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def get(self, _: str) -> _BhavcopyResponse:
        return _BhavcopyResponse(self.payload)


def parse_day(value: str) -> date:
    """Parse an ISO date and reject ambiguous date formats."""

    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"Invalid ISO date: {value}") from error


def archive_url(day: date) -> tuple[str, str]:
    """Return the official URL and schema family for one exchange day."""

    if day >= UDIFF_START:
        return (
            f"{ARCHIVE_HOST}/content/fo/"
            f"BhavCopy_NSE_FO_0_0_0_{day:%Y%m%d}_F_0000.csv.zip",
            "udiff",
        )
    month = day.strftime("%b").upper()
    return (
        f"{ARCHIVE_HOST}/content/historical/DERIVATIVES/"
        f"{day:%Y}/{month}/fo{day:%d}{month}{day:%Y}bhav.csv.zip",
        "legacy",
    )


def sha256(payload: bytes) -> str:
    """Compute the content identity stored in the resumable manifest."""

    return hashlib.sha256(payload).hexdigest()


def atomic_write(path: Path, payload: bytes) -> None:
    """Replace one output only after its complete payload reaches disk."""

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.part")
    temporary.write_bytes(payload)
    os.replace(temporary, path)


def parse_decimal(value: str | None, field: str, *, nullable: bool = False) -> float | None:
    """Parse a finite nonnegative decimal without accepting blank required data."""

    text = (value or "").strip()
    if not text and nullable:
        return None
    try:
        number = float(text)
    except ValueError as error:
        raise ArchiveValidationError(f"Invalid {field}: {text!r}") from error
    if not math.isfinite(number) or number < 0:
        raise ArchiveValidationError(f"Invalid {field}: {text!r}")
    return number


def parse_integer(
    value: str | None,
    field: str,
    *,
    nullable: bool = False,
    signed: bool = False,
) -> int | None:
    """Parse an integral archive field and enforce its permitted sign."""

    text = (value or "").strip()
    if not text and nullable:
        return None
    try:
        number = float(text)
    except ValueError as error:
        raise ArchiveValidationError(f"Invalid integer {field}: {value!r}") from error
    if (
        not math.isfinite(number)
        or not number.is_integer()
        or (not signed and number < 0)
    ):
        raise ArchiveValidationError(f"Invalid integer {field}: {value!r}")
    return int(number)


def compact_number(value: float | int | None) -> str:
    """Serialize validated numbers without locale or avoidable trailing zeros."""

    if value is None:
        return ""
    return format(value, ".12g")


def read_single_csv(payload: bytes) -> str:
    """Extract exactly one bounded CSV member without writing archive paths."""

    if len(payload) > MAX_ARCHIVE_BYTES:
        raise ArchiveValidationError("Archive exceeds the configured size limit.")
    try:
        archive = zipfile.ZipFile(io.BytesIO(payload))
    except zipfile.BadZipFile as error:
        raise ArchiveValidationError("Downloaded payload is not a valid ZIP archive.") from error
    with archive:
        members = [member for member in archive.infolist() if not member.is_dir()]
        if len(members) != 1 or not members[0].filename.lower().endswith(".csv"):
            raise ArchiveValidationError("Archive must contain exactly one CSV file.")
        member = members[0]
        if member.file_size > MAX_CSV_BYTES or member.compress_size > MAX_ARCHIVE_BYTES:
            raise ArchiveValidationError("Archive member exceeds the configured size limit.")
        if Path(member.filename).name != member.filename.replace("\\", "/"):
            raise ArchiveValidationError("Archive contains an unsafe member path.")
        raw = archive.read(member)
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ArchiveValidationError("Archive CSV is not valid UTF-8.") from error


def prepare_legacy_archive_with_bhavcopy(payload: bytes, report_day: date) -> bytes:
    """Parse a safe legacy archive through bhavcopy and return one canonical ZIP.

    bhavcopy 3.0 only understands the legacy derivative report. The repository
    owns HTTPS transport and ZIP validation, then supplies those exact bytes to
    the package so it cannot make its own HTTP request or extract an unsafe path.
    """

    read_single_csv(payload)
    try:
        module = importlib.import_module("bhavcopy.downloader")
    except ModuleNotFoundError as error:
        raise ArchiveValidationError(
            "bhavcopy 3.0 is required for legacy archives; install scripts/requirements-bhavcopy.lock."
        ) from error
    original_session = module.requests.Session
    module.requests.Session = lambda: _BhavcopySession(payload)
    try:
        with TemporaryDirectory(prefix="nralgo-bhavcopy-") as folder:
            client = module.bhavcopy(
                "derivatives",
                report_day,
                report_day,
                folder,
                [0, 0],
            )
            client.extraction_engine(report_day)
            frame = client.temp
    except Exception as error:
        raise ArchiveValidationError(
            f"bhavcopy could not parse the legacy derivative archive: {error}"
        ) from error
    finally:
        module.requests.Session = original_session
    if frame is None or frame.empty:
        raise ArchiveValidationError("bhavcopy returned no legacy derivative rows.")
    frame["TIMESTAMP"] = report_day.strftime("%d-%b-%Y")
    csv_payload = frame.to_csv(index=False, lineterminator="\n").encode("utf-8")
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("bhavcopy-legacy.csv", csv_payload)
    return output.getvalue()


def normalize_archive(
    payload: bytes,
    report_day: date,
    symbols: Iterable[str],
    current_next: bool = False,
) -> tuple[list[dict[str, str]], str, int]:
    """Normalize genuine index/stock options; ALL and current_next support one closing snapshot."""

    text = read_single_csv(payload)
    reader = csv.DictReader(io.StringIO(text))
    fields = set(reader.fieldnames or ())
    if LEGACY_REQUIRED.issubset(fields):
        family = "legacy"
    elif UDIFF_REQUIRED.issubset(fields):
        family = "udiff"
    else:
        raise ArchiveValidationError("Unrecognized NSE F&O bhavcopy schema.")
    allowed = {symbol.strip().upper() for symbol in symbols if symbol.strip()}
    normalized: list[dict[str, str]] = []
    skipped = 0
    observed_report_days: set[date] = set()
    seen: set[tuple[str, str, str, str]] = set()
    for source in reader:
        if family == "legacy":
            actual_day = datetime.strptime(source["TIMESTAMP"].strip(), "%d-%b-%Y").date()
            observed_report_days.add(actual_day)
            underlying = source["SYMBOL"].strip().upper()
            option_type = source["OPTION_TYP"].strip().upper()
            if source["INSTRUMENT"].strip() not in {"OPTIDX", "OPTSTK"} or ("ALL" not in allowed and underlying not in allowed) or option_type not in {"CE", "PE"}:
                skipped += 1
                continue
            expiry = datetime.strptime(source["EXPIRY_DT"].strip(), "%d-%b-%Y").date()
            values = {
                "open": source["OPEN"],
                "high": source["HIGH"],
                "low": source["LOW"],
                "close": source["CLOSE"],
                "settlement": source["SETTLE_PR"],
                "volume": source["CONTRACTS"],
                "open_interest": source["OPEN_INT"],
                "change_open_interest": source["CHG_IN_OI"],
                "lot_size": None,
                "underlying_price": None,
            }
        else:
            actual_day = date.fromisoformat(source["TradDt"].strip())
            observed_report_days.add(actual_day)
            underlying = source["TckrSymb"].strip().upper()
            option_type = source["OptnTp"].strip().upper()
            if source["FinInstrmTp"].strip() not in {"IDO", "STO"} or ("ALL" not in allowed and underlying not in allowed) or option_type not in {"CE", "PE"}:
                skipped += 1
                continue
            expiry = date.fromisoformat(source["XpryDt"].strip())
            values = {
                "open": source["OpnPric"],
                "high": source["HghPric"],
                "low": source["LwPric"],
                "close": source["ClsPric"],
                "settlement": source["SttlmPric"],
                "volume": source["TtlTradgVol"],
                "open_interest": source["OpnIntrst"],
                "change_open_interest": source["ChngInOpnIntrst"],
                "lot_size": source["NewBrdLotQty"],
                "underlying_price": source["UndrlygPric"],
            }
        strike = parse_decimal(
            source["STRIKE_PR"] if family == "legacy" else source["StrkPric"],
            "strike",
        )
        open_price = parse_decimal(values["open"], "open")
        high = parse_decimal(values["high"], "high")
        low = parse_decimal(values["low"], "low")
        close = parse_decimal(values["close"], "close")
        settlement = parse_decimal(values["settlement"], "settlement", nullable=True)
        if not strike or (not close and not settlement):
            skipped += 1
            continue
        if open_price and high and low and (high < max(open_price, close, low) or low > min(open_price, close)):
            raise ArchiveValidationError("Inconsistent option OHLC range.")
        volume = parse_integer(values["volume"], "volume", nullable=True)
        open_interest = parse_integer(values["open_interest"], "open interest", nullable=True)
        change_open_interest = parse_integer(
            values["change_open_interest"],
            "change in open interest",
            nullable=True,
            signed=True,
        )
        lot_size = parse_integer(values["lot_size"], "lot size", nullable=True)
        underlying_price = parse_decimal(
            values["underlying_price"], "underlying price", nullable=True
        )
        if lot_size == 0:
            lot_size = None
        key = (underlying, expiry.isoformat(), option_type, compact_number(strike))
        if key in seen:
            raise ArchiveValidationError(f"Duplicate contract in archive: {key}")
        seen.add(key)
        normalized.append(
            {
                "day": actual_day.isoformat(),
                "underlying": underlying,
                "expiry_date": expiry.isoformat(),
                "right": "call" if option_type == "CE" else "put",
                "strike_price": compact_number(strike),
                "open": compact_number(open_price),
                "high": compact_number(high),
                "low": compact_number(low),
                "close": compact_number(close),
                "settlement": compact_number(settlement),
                "volume": compact_number(volume),
                "open_interest": compact_number(open_interest),
                "change_open_interest": compact_number(change_open_interest),
                "lot_size": compact_number(lot_size),
                "underlying_price": compact_number(underlying_price),
                "source": f"nse-fno-{family}",
            }
        )
    if observed_report_days != {report_day}:
        raise ArchiveValidationError(
            f"Archive reports {sorted(day.isoformat() for day in observed_report_days)}, expected {report_day}."
        )
    if current_next:
        expiries: dict[str, set[str]] = {}
        for row in normalized:
            if row["expiry_date"] >= report_day.isoformat():
                expiries.setdefault(row["underlying"], set()).add(row["expiry_date"])
        nearest = {symbol: sorted(days)[:2] for symbol, days in expiries.items()}
        normalized = [row for row in normalized if row["expiry_date"] in nearest.get(row["underlying"], [])]
    normalized.sort(
        key=lambda row: (
            row["underlying"],
            row["expiry_date"],
            float(row["strike_price"]),
            row["right"],
        )
    )
    return normalized, family, skipped


def encode_normalized(rows: list[dict[str, str]]) -> bytes:
    """Encode normalized rows as a deterministic UTF-8 CSV payload."""

    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=NORMALIZED_FIELDS, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue().encode("utf-8")


def download(url: str, attempts: int = 4) -> bytes:
    """Fetch one public archive with bounded retries for transient failures."""

    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "NRIAlgo historical-data importer (+local operator)",
            "Accept": "application/zip,application/octet-stream",
        },
    )
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                length = int(response.headers.get("Content-Length", "0") or 0)
                if length > MAX_ARCHIVE_BYTES:
                    raise ArchiveValidationError("Remote archive exceeds the size limit.")
                payload = response.read(MAX_ARCHIVE_BYTES + 1)
                if len(payload) > MAX_ARCHIVE_BYTES:
                    raise ArchiveValidationError("Remote archive exceeds the size limit.")
                return payload
        except urllib.error.HTTPError as error:
            if error.code in {404, 410}:
                raise ArchiveUnavailableError(url) from error
            if error.code not in {429, 500, 502, 503, 504} or attempt == attempts - 1:
                raise
            retry_after = error.headers.get("Retry-After")
            wait = float(retry_after) if retry_after and retry_after.isdigit() else 2**attempt
        except (TimeoutError, urllib.error.URLError):
            if attempt == attempts - 1:
                raise
            wait = 2**attempt
        time.sleep(wait + random.uniform(0, 0.25))
    raise RuntimeError("Download retries exhausted.")


def load_manifest(path: Path) -> dict[str, object]:
    """Read an existing manifest or create its stable empty shape."""

    if not path.exists():
        return {"version": 1, "days": {}}
    parsed = json.loads(path.read_text("utf-8"))
    if parsed.get("version") != 1 or not isinstance(parsed.get("days"), dict):
        raise ArchiveValidationError("Unsupported or invalid downloader manifest.")
    return parsed


def save_manifest(path: Path, manifest: dict[str, object]) -> None:
    """Persist progress atomically after every processed day."""

    atomic_write(path, (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode())


def is_complete(entry: object, raw_path: Path, normalized_path: Path, symbols: tuple[str, ...]) -> bool:
    """Resume only when both saved artifacts still match their manifest hashes."""

    if not isinstance(entry, dict) or entry.get("status") != "complete":
        return False
    if not raw_path.is_file() or not normalized_path.is_file():
        return False
    return (
        entry.get("normalizerVersion") == NORMALIZER_VERSION
        and entry.get("symbols") == sorted(symbols)
        and sha256(raw_path.read_bytes()) == entry.get("rawSha256")
        and sha256(normalized_path.read_bytes()) == entry.get("normalizedSha256")
    )


def iter_days(first: date, last: date) -> Iterable[date]:
    """Probe every date: special exchange sessions can fall on weekends.

    A missing archive is recorded as unavailable, never certified as a holiday.
    """

    current = first
    while current <= last:
        yield current
        current += timedelta(days=1)


def run(args: argparse.Namespace) -> int:
    """Download, validate, normalize, and checkpoint the requested date range."""

    if args.to_day < args.from_day:
        raise SystemExit("--to must be on or after --from")
    if (args.to_day - args.from_day).days > 1900:
        raise SystemExit("A single run is limited to 1,901 calendar days.")
    if args.delay < 1:
        raise SystemExit("--delay must be at least one second.")
    symbols = tuple(dict.fromkeys(symbol.upper() for symbol in args.symbols))
    if not symbols or any(not re.fullmatch(r"[A-Z0-9&_.-]{1,40}", symbol) for symbol in symbols):
        raise SystemExit("Invalid --symbols value.")
    root = args.output.resolve()
    manifest_path = root / "manifest.json"
    manifest = load_manifest(manifest_path)
    days = manifest["days"]
    assert isinstance(days, dict)
    failures = 0
    requested = list(iter_days(args.from_day, args.to_day))
    for index, day in enumerate(requested):
        key = day.isoformat()
        raw_path = root / "raw" / f"{key}.zip"
        normalized_path = root / "normalized" / f"{key}.csv"
        if is_complete(days.get(key), raw_path, normalized_path, symbols) and bool(days[key].get("currentNext", False)) == args.current_next:
            print(f"skip {key}: verified local copy")
            continue
        url, expected_family = archive_url(day)
        try:
            prior = days.get(key)
            payload = args.archive.read_bytes() if args.archive else (
                raw_path.read_bytes()
                if isinstance(prior, dict)
                and raw_path.is_file()
                and sha256(raw_path.read_bytes()) == prior.get("rawSha256")
                else download(url)
            )
            normalization_payload = (
                prepare_legacy_archive_with_bhavcopy(payload, day)
                if expected_family == "legacy" and args.legacy_provider == "bhavcopy"
                else payload
            )
            rows, family, skipped = normalize_archive(
                normalization_payload, day, symbols, args.current_next
            )
            if family != expected_family:
                raise ArchiveValidationError(
                    f"Unexpected schema family {family}; expected {expected_family}."
                )
            normalized = encode_normalized(rows)
            atomic_write(raw_path, payload)
            atomic_write(normalized_path, normalized)
            days[key] = {
                "status": "complete",
                "normalizerVersion": NORMALIZER_VERSION,
                "symbols": sorted(symbols),
                "currentNext": args.current_next,
                "url": url,
                "schema": family,
                "legacyProvider": (
                    args.legacy_provider if expected_family == "legacy" else None
                ),
                "rawSha256": sha256(payload),
                "normalizedSha256": sha256(normalized),
                "acceptedRows": len(rows),
                "skippedRows": skipped,
                "downloadedAt": datetime.now(timezone.utc).isoformat(),
                "imported": False,
            }
            print(f"saved {key}: {len(rows)} option rows ({family})")
        except ArchiveUnavailableError:
            days[key] = {"status": "unavailable", "url": url}
            print(f"unavailable {key}")
            if not args.skip_unavailable:
                failures += 1
        except Exception as error:  # noqa: BLE001 - operator report must checkpoint failures
            days[key] = {"status": "invalid", "url": url, "error": str(error)[:500]}
            failures += 1
            print(f"failed {key}: {error}", file=sys.stderr)
            save_manifest(manifest_path, manifest)
            if not args.continue_invalid:
                return 1
        save_manifest(manifest_path, manifest)
        if index < len(requested) - 1:
            time.sleep(args.delay)
    return 1 if failures else 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Define the explicit, bounded operator interface."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--from", dest="from_day", type=parse_day, required=True)
    parser.add_argument("--to", dest="to_day", type=parse_day, required=True)
    parser.add_argument("--symbols", nargs="+", default=list(DEFAULT_SYMBOLS))
    parser.add_argument("--current-next", action="store_true", help="Keep only the two nearest expiries per underlying.")
    parser.add_argument("--archive", type=Path, help="Use a local official archive; its report date is still validated.")
    parser.add_argument("--output", type=Path, default=Path(".runtime/nse-fno"))
    parser.add_argument("--delay", type=float, default=1.5)
    parser.add_argument(
        "--legacy-provider",
        choices=("bhavcopy", "native"),
        default="bhavcopy",
        help="Parser for pre-UDiFF derivative archives (default: bhavcopy).",
    )
    parser.add_argument("--skip-unavailable", action="store_true")
    parser.add_argument("--continue-invalid", action="store_true")
    return parser.parse_args(argv)


if __name__ == "__main__":
    raise SystemExit(run(parse_args()))
