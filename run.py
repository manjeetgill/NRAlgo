"""One local command starts the API, paper worker, and Next.js. Ctrl+C stops all."""
import os
import json
import threading
import urllib.error
import urllib.request
import webbrowser
import signal
import subprocess
import sys
import time
from pathlib import Path
from backend.database import initialize

ROOT = Path(__file__).resolve().parent
APP_URL = 'http://localhost:3000'


def open_browser_when_ready(processes, timeout=90):
    """Open one tab after the frontend and proxied Python API respond."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if any(process.poll() is not None for process in processes):
            return
        try:
            with opener.open(APP_URL + '/api/health', timeout=3) as response:
                health = json.load(response)
            if health.get('service') != 'nexus-fastapi' or health.get('status') != 'ok':
                time.sleep(.5)
                continue
            with opener.open(APP_URL, timeout=5) as response:
                ready = response.status == 200
            if ready and all(process.poll() is None for process in processes):
                try:
                    opened = webbrowser.open(APP_URL, new=2)
                except webbrowser.Error:
                    opened = False
                if not opened:
                    print(f'Open {APP_URL} in your browser.', flush=True)
                return
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            pass
        time.sleep(.5)
    print(f'Automatic browser opening timed out. When ready, open {APP_URL}.', flush=True)


def main():
    initialize()
    processes = []
    commands = [
        ([sys.executable, '-m', 'uvicorn', 'backend.main:app', '--host', '127.0.0.1', '--port', '8000'], ROOT),
        ([sys.executable, '-m', 'backend.worker'], ROOT),
        (['npm', 'run', 'dev'], ROOT / 'frontend'),
    ]
    try:
        for command, cwd in commands:
            processes.append(subprocess.Popen(command, cwd=cwd, start_new_session=True))
        print('\nNexus: http://localhost:3000 · API docs: http://127.0.0.1:8000/api/docs\n', flush=True)
        if os.getenv('NEXUS_NO_BROWSER') != '1':
            threading.Thread(target=open_browser_when_ready, args=(processes,), daemon=True).start()
        while all(process.poll() is None for process in processes):
            time.sleep(1)
        raise RuntimeError('A service exited. See its output above; all services will stop.')
    except KeyboardInterrupt:
        pass
    finally:
        for process in processes:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
        for process in processes:
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)


if __name__ == '__main__':
    main()
