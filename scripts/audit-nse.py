"""Audit raw official NSE downloads without treating missing files as holidays."""
import argparse
from collections import Counter, defaultdict
from datetime import date, timedelta
import hashlib
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location("nse_downloader", Path(__file__).with_name("download-nse.py"))
downloader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(downloader)


def audit(folder, start, end, verify=False):
    manifest = json.loads((folder / "manifest.json").read_text())
    calendar = json.loads(Path(__file__).with_name("nse-calendar-reference.json").read_text())
    closures = {day: group["source"] for group in calendar["groups"] for day in group["closedDates"]}
    counts = Counter()
    by_year = defaultdict(Counter)
    rows = Counter()
    issues = []
    missing = []
    asymmetric = []
    ranges = defaultdict(list)
    total_bytes = 0
    day = start
    while day <= end:
        statuses = {}
        for kind in ("equity", "indices"):
            key = f"{day}:{kind}"
            entry = manifest.get(key, {})
            status = entry.get("status", "unattempted")
            statuses[kind] = status
            counts[status] += 1
            by_year[str(day.year)][f"{kind}_{status}"] += 1
            if status == "downloaded":
                target = folder / f"{day}-{kind}{'.zip' if kind == 'equity' else '.csv'}"
                if not target.exists():
                    issues.append({"key": key, "problem": "file_missing"})
                    continue
                total_bytes += target.stat().st_size
                rows[kind] += entry["rows"]
                ranges[kind].append(str(day))
                if verify:
                    payload = target.read_bytes()
                    if hashlib.sha256(payload).hexdigest() != entry["sha256"]:
                        issues.append({"key": key, "problem": "checksum_mismatch"})
                    try:
                        if downloader.validate(payload, kind, day) != entry["rows"]:
                            issues.append({"key": key, "problem": "row_count_mismatch"})
                    except Exception as error:
                        issues.append({"key": key, "problem": type(error).__name__, "detail": str(error)})
            else:
                classification = "unresolved"
                if status == "unavailable":
                    classification = "documented_cm_closure" if str(day) in closures else "weekend_not_session_verified" if day.weekday() >= 5 else "unexplained_weekday"
                missing.append({"key": key, "status": status, "weekday": day.strftime("%A"), "httpStatus": entry.get("httpStatus"), "url": entry.get("url"), "calendarClassification": classification, "calendarSource": closures.get(str(day))})
        if "downloaded" in statuses.values() and len(set(statuses.values())) > 1:
            asymmetric.append({"day": str(day), **statuses})
        day += timedelta(days=1)
    return {
        "from": str(start), "to": str(end), "expectedRequests": ((end - start).days + 1) * 2,
        "counts": dict(counts), "rawRows": dict(rows), "bytes": total_bytes,
        "coverageByYear": dict(by_year),
        "downloadedRanges": {kind: {"first": min(days), "last": max(days), "reports": len(days)} for kind, days in ranges.items()},
        "integrityVerified": verify, "integrityIssues": issues,
        "asymmetricDates": asymmetric, "missingReports": missing,
        "unavailableClassification": dict(Counter(item["calendarClassification"] for item in missing if item["status"] == "unavailable")),
        "unexplainedWeekdayDates": sorted({item["key"].split(":")[0] for item in missing if item["calendarClassification"] == "unexplained_weekday"}),
        "calendarLimitations": calendar["note"],
        "rangeScanned": not counts["unattempted"] and not counts["failed"],
        "imported": False,
        "caveat": "404 means unavailable at the requested official URL, not a verified holiday. Raw row counts do not establish per-instrument completeness. Daily reports are not intraday data.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--from", dest="start", required=True, type=date.fromisoformat)
    parser.add_argument("--to", dest="end", required=True, type=date.fromisoformat)
    parser.add_argument("--directory", type=Path, default=Path(__file__).resolve().parents[1] / ".runtime/nse-official")
    parser.add_argument("--verify", action="store_true", help="Read every archive, verify SHA-256, format and report dates")
    args = parser.parse_args()
    if args.start > args.end:
        parser.error("Start must not be after end")
    report = audit(args.directory, args.start, args.end, args.verify)
    output = args.directory / "coverage.json"
    downloader.atomic_json(output, report)
    print(json.dumps({key: value for key, value in report.items() if key not in ("missingReports", "asymmetricDates")}, indent=2))
    print(f"Detailed coverage: {output}")
    return 1 if report["integrityIssues"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
