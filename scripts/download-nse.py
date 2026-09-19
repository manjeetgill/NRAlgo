"""Download official NSE daily archives; no credentials, browser impersonation or access bypass.

Download-only: validates archive structure and dates, never imports unverified files into PostgreSQL.
"""
import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
from datetime import date, datetime, timedelta
from urllib.request import urlopen, Request
from urllib.error import HTTPError
import zipfile
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from threading import Event
from urllib.error import URLError

ROOT = "https://nsearchives.nseindia.com"
MAX_BYTES = 15 * 1024 * 1024
# Observed official all-index reports use MM-DD-YYYY on these three dates.
# Cross-checked against adjacent official closes/points changes; see data docs.
# Do not infer arbitrary month/day swaps on other dates or equity reports.
INDEX_MONTH_FIRST_DATES = {date(2023, 4, 6), date(2023, 4, 10), date(2023, 4, 11)}


def sources(day):
    stamp = day.strftime("%d%m%Y")
    if day >= date(2024, 7, 8):
        equity = f"/content/cm/BhavCopy_NSE_CM_0_0_0_{day:%Y%m%d}_F_0000.csv.zip"
    else:
        month = day.strftime("%b").upper()
        equity = f"/content/historical/EQUITIES/{day.year}/{month}/cm{day:%d}{month}{day.year}bhav.csv.zip"
    return {"equity": ROOT + equity, "indices": ROOT + f"/content/indices/ind_close_all_{stamp}.csv"}


def parse_day(value):
    for fmt in ("%Y-%m-%d", "%d-%b-%Y", "%d-%m-%Y", "%d %b %Y"):
        try:
            return datetime.strptime(value.strip(), fmt).date()
        except ValueError:
            pass
    raise ValueError("Unrecognized report date")


def validate(payload, kind, day):
    if kind == "equity":
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            members = [member for member in archive.infolist() if member.filename.lower().endswith(".csv")]
            if len(members) != 1 or members[0].file_size > 50 * 1024 * 1024:
                raise ValueError("Unexpected archive contents or size")
            # Read in memory, never extract paths or execute archive content.
            payload = archive.read(members[0])
    reader = csv.DictReader(io.StringIO(payload.decode("utf-8-sig")))
    rows = [{str(k).strip(): (v or "").strip() for k, v in row.items() if k is not None} for row in reader]
    if not rows:
        raise ValueError("Empty CSV")
    keys = rows[0].keys()
    if kind == "indices":
        required, field = {"Index Name", "Index Date", "Open Index Value", "High Index Value", "Low Index Value", "Closing Index Value"}, "Index Date"
    elif "TradDt" in keys:
        required, field = {"TradDt", "TckrSymb", "SctySrs", "OpnPric", "HghPric", "LwPric", "ClsPric"}, "TradDt"
    else:
        required, field = {"SYMBOL", "SERIES", "TIMESTAMP", "OPEN", "HIGH", "LOW", "CLOSE"}, "TIMESTAMP"
    if not required.issubset(keys):
        raise ValueError("Unexpected CSV columns; inspect format before importing")
    def matches_report_day(value):
        if parse_day(value) == day:
            return True
        if kind == "indices" and day in INDEX_MONTH_FIRST_DATES:
            try:
                return datetime.strptime(value.strip(), "%m-%d-%Y").date() == day
            except ValueError:
                return False
        return False
    if any(not matches_report_day(row[field]) for row in rows):
        raise ValueError("Report date differs from requested date")
    return len(rows)


def atomic_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2), encoding="utf-8")
    temporary.replace(path)


def fetch_report(day, kind, url, target, delay, stopped, continue_invalid=False):
    """A bounded worker; only the coordinator may write the shared manifest."""
    for attempt in range(3):
        if stopped.is_set():
            return None
        try:
            with urlopen(Request(url, headers={"User-Agent": "NRIAlgo-NSE-Archive-Downloader/1.0"}), timeout=25) as response:
                payload = response.read(MAX_BYTES + 1)
            if len(payload) > MAX_BYTES:
                raise ValueError("Response too large")
            count = validate(payload, kind, day)
            temporary = target.with_suffix(target.suffix + ".part")
            temporary.write_bytes(payload)
            temporary.replace(target)
            entry = {"status": "downloaded", "url": url, "sha256": hashlib.sha256(payload).hexdigest(), "rows": count, "bytes": len(payload), "imported": False}
            if kind == "indices" and day in INDEX_MONTH_FIRST_DATES:
                entry["dateValidationNote"] = "Reviewed legacy index date: DD-MM-YYYY or MM-DD-YYYY; original bytes retained"
        except HTTPError as error:
            if error.code in (500, 502, 503, 504) and attempt < 2:
                stopped.wait(5 * (attempt + 1))
                continue
            entry = {"status": "unavailable" if error.code == 404 else "failed", "url": url, "httpStatus": error.code}
        except (URLError, TimeoutError, ConnectionError) as error:
            if attempt < 2:
                stopped.wait(5 * (attempt + 1))
                continue
            entry = {"status": "failed", "url": url, "error": type(error).__name__}
        except (ValueError, zipfile.BadZipFile, UnicodeError, csv.Error) as error:
            entry = {"status": "failed", "url": url, "error": type(error).__name__, "detail": str(error), "validationFailure": True}
        except Exception as error:
            entry = {"status": "failed", "url": url, "error": type(error).__name__, "detail": str(error)}
        entry["checkedAt"] = datetime.now().astimezone().isoformat()
        if entry["status"] == "failed" and not (continue_invalid and entry.get("validationFailure")):
            stopped.set()
        else:
            stopped.wait(delay)
        return entry


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--from", dest="start", required=True, type=date.fromisoformat)
    parser.add_argument("--to", dest="end", required=True, type=date.fromisoformat)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / ".runtime/nse-official")
    parser.add_argument("--delay", type=float, default=1.5)
    parser.add_argument("--workers", type=int, default=1, choices=range(1, 5), help="At most four concurrent requests; delay applies per worker")
    parser.add_argument("--skip-unavailable", action="store_true", help="Resume past recorded 404s; omit for a separate missing-file recheck")
    parser.add_argument("--continue-invalid", action="store_true", help="Record rejected data as failed and continue other dates; access/network failures still stop")
    args = parser.parse_args()
    if args.start > args.end or (args.end - args.start).days > 1900 or args.end >= date.today() or args.delay < 1:
        parser.error("Use a past range of at most 1,900 days and delay >= 1 second")
    args.output.mkdir(parents=True, exist_ok=True)
    manifest_path = args.output / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    downloaded = cached = unavailable = 0
    failures = []
    pending = []
    day = args.end
    # Include weekends because NSE occasionally has special trading sessions.
    while day >= args.start:
        for kind, url in sources(day).items():
            key = f"{day.isoformat()}:{kind}"
            target = args.output / f"{day.isoformat()}-{kind}{'.zip' if kind == 'equity' else '.csv'}"
            entry = manifest.get(key, {})
            if entry.get("status") == "downloaded" and target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == entry.get("sha256"):
                cached += 1
                continue
            if args.skip_unavailable and entry.get("status") == "unavailable":
                unavailable += 1
                continue
            pending.append((key, day, kind, url, target))
        day -= timedelta(days=1)
    stopped = Event()
    tasks = iter(pending)
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        active = {}
        def submit_next():
            task = next(tasks, None)
            if task and not stopped.is_set():
                key, day, kind, url, target = task
                active[pool.submit(fetch_report, day, kind, url, target, args.delay, stopped, args.continue_invalid)] = key
        for _ in range(args.workers):
            submit_next()
        while active:
            completed, _ = wait(active, return_when=FIRST_COMPLETED)
            for future in completed:
                key = active.pop(future)
                entry = future.result()
                if entry is not None:
                    manifest[key] = entry
                    if entry["status"] == "downloaded":
                        downloaded += 1
                        print(f"Downloaded {key}: {entry['rows']} rows", flush=True)
                    elif entry["status"] == "unavailable":
                        unavailable += 1
                    else:
                        failures.append(key)
                        print(f"{'Stopping' if stopped.is_set() else 'Rejected'}: {key}: {entry}", flush=True)
                    atomic_json(manifest_path, manifest)
                submit_next()
    print(json.dumps({"downloaded": downloaded, "cached": cached, "unavailable_dates": unavailable, "failed": failures, "manifest": str(manifest_path), "imported": False}), flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
