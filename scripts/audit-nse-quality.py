"""Read-only row and instrument coverage audit of validated official daily archives.

Writes only a diagnostic JSON report, never repairs or imports market data.
Missing observations are candidates, not proof of missing trades/listings.
"""
import argparse
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
import csv
import hashlib
import io
import json
import math
from pathlib import Path
import zipfile


def row_fields(row, kind):
    if kind == "indices":
        return row.get("Index Name", ""), [row.get(k, "") for k in ("Open Index Value", "High Index Value", "Low Index Value", "Closing Index Value")]
    if "TradDt" in row:
        return f"{row.get('TckrSymb', '')}:{row.get('SctySrs', '')}", [row.get(k, "") for k in ("OpnPric", "HghPric", "LwPric", "ClsPric")]
    return f"{row.get('SYMBOL', '')}:{row.get('SERIES', '')}", [row.get(k, "") for k in ("OPEN", "HIGH", "LOW", "CLOSE")]


def price_issue(values):
    try:
        o, h, lo, c = [float(v.replace(",", "")) for v in values]
    except (ValueError, AttributeError):
        return "missing_or_non_numeric_ohlc"
    if not all(math.isfinite(v) and v > 0 for v in (o, h, lo, c)):
        return "non_positive_or_non_finite_ohlc"
    if lo > h or h < max(o, c) or lo > min(o, c):
        return "inconsistent_ohlc"
    return None


def audit(folder, start, end):
    raw_manifest = (folder / "manifest.json").read_bytes()
    manifest = json.loads(raw_manifest)
    issues, examples, file_issues = Counter(), [], []
    example_counts = Counter()
    observed, valid = defaultdict(set), defaultdict(set)
    sessions, rows = defaultdict(set), Counter()
    reports = Counter()
    for key, entry in sorted(manifest.items()):
        day, kind = key.split(":")
        if not start <= day <= end or entry.get("status") != "downloaded":
            continue
        target = folder / f"{day}-{kind}{'.zip' if kind == 'equity' else '.csv'}"
        try:
            payload = target.read_bytes()
            if hashlib.sha256(payload).hexdigest() != entry["sha256"]:
                raise ValueError("checksum_mismatch")
            if kind == "equity":
                with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                    members = [m for m in archive.infolist() if m.filename.lower().endswith(".csv")]
                    if len(members) != 1 or members[0].file_size > 50 * 1024 * 1024:
                        raise ValueError("unexpected_archive")
                    payload = archive.read(members[0])
            reader = csv.DictReader(io.StringIO(payload.decode("utf-8-sig")))
            seen = set()
            for raw in reader:
                row = {str(k).strip(): (v or "").strip() for k, v in raw.items() if k is not None}
                name, values = row_fields(row, kind)
                identity = f"{kind}:{name}"
                rows[kind] += 1
                observed[identity].add(day)
                reasons = []
                if not name or name.startswith(":"):
                    reasons.append("missing_instrument_identity")
                if name in seen:
                    reasons.append("duplicate_identity_in_report")
                seen.add(name)
                problem = price_issue(values)
                if problem:
                    reasons.append(problem)
                if not reasons:
                    valid[identity].add(day)
                for problem in reasons:
                    issues[f"{kind}:{problem}"] += 1
                    if example_counts[f"{kind}:{problem}"] < 20:
                        examples.append({"report": key, "instrument": name, "problem": problem, "ohlc": values})
                        example_counts[f"{kind}:{problem}"] += 1
            sessions[kind].add(day)
            reports[kind] += 1
        except (OSError, ValueError, zipfile.BadZipFile, UnicodeError, csv.Error) as error:
            file_issues.append({"report": key, "error": str(error)})
    inventory = []
    for identity, days in sorted(observed.items()):
        kind = identity.split(":", 1)[0]
        first, last = min(days), max(days)
        candidates = sorted(d for d in sessions[kind] if first <= d <= last and d not in days)
        inventory.append({"instrument": identity, "first": first, "last": last,
                          "observedDays": len(days), "validOhlcDays": len(valid[identity]),
                          "unobservedReportDatesWithinSpan": len(candidates), "gapExamples": candidates[:20]})
    return {"from": start, "to": end, "auditedAt": datetime.now(timezone.utc).isoformat(),
            "manifestSha256": hashlib.sha256(raw_manifest).hexdigest(),
            "manifestChangedDuringAudit": (folder / "manifest.json").read_bytes() != raw_manifest,
            "reports": dict(reports), "rawRows": dict(rows), "rowIssues": dict(issues),
            "issueExamples": examples, "fileIssues": file_issues, "instruments": inventory,
            "instrumentCount": len(inventory), "completeCoverageCertified": False, "imported": False,
            "limitations": "Inventory is by raw symbol/series or index name, not stable security identity. No listing, suspension, rename, corporate-action or historical calendar reconciliation. Missing observations may be legitimate. Some index series do not publish tradable OHLC. Raw reports cover more series than ordinary shares. A clean file/row check cannot certify every security or all history. Run audit-nse.py --verify separately for report dates and whole-range request coverage."}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--from", dest="start", type=date.fromisoformat, required=True)
    parser.add_argument("--to", dest="end", type=date.fromisoformat, required=True)
    parser.add_argument("--directory", type=Path, default=Path(__file__).resolve().parents[1] / ".runtime/nse-official")
    args = parser.parse_args()
    if args.start > args.end:
        parser.error("Start must not be after end")
    report = audit(args.directory, str(args.start), str(args.end))
    output = args.directory / "quality.json"
    temporary = output.with_suffix(".tmp")
    temporary.write_text(json.dumps(report, indent=2))
    temporary.replace(output)
    print(json.dumps({k: v for k, v in report.items() if k not in ("instruments", "issueExamples")}, indent=2))
    print(f"Detailed instrument inventory: {output}")
