"""Single-task ASGI supervisor: bounded input, killable computation and no broker access.

Run this entrypoint, not app:app. The numerical FastAPI app is imported only in
the child. A host-local file lock also rejects accidental extra Uvicorn workers.
Deploy exactly one calculator container; PostgreSQL leases coordinate Node jobs.
"""

from __future__ import annotations

import asyncio
import ctypes
import fcntl
import hmac
import json
import multiprocessing
import os
from pathlib import Path
import resource
import signal
import sys
import tempfile
import time

from . import ENGINE_VERSION

MAX_INPUT = 8 * 1024 * 1024
MAX_OUTPUT = 12 * 1024 * 1024
WALL_SECONDS = int(os.environ.get("CALCULATION_WALL_SECONDS", "90"))
if not 1 <= WALL_SECONDS <= 90:
    raise RuntimeError("Calculation wall time must be between 1 and 90 seconds")
token_file = os.environ.get("CALCULATION_SERVICE_TOKEN_FILE")
if token_file:
    if not token_file.startswith("/run/secrets/") or os.environ.get("CALCULATION_SERVICE_TOKEN"):
        raise RuntimeError("Use only the mounted calculation token")
    os.environ["CALCULATION_SERVICE_TOKEN"] = Path(token_file).read_text().strip()
    del os.environ["CALCULATION_SERVICE_TOKEN_FILE"]  # Spawned children inherit the resolved token only.
TOKEN = os.environ.get("CALCULATION_SERVICE_TOKEN", "")
if len(TOKEN) < 32:
    raise RuntimeError("CALCULATION_SERVICE_TOKEN requires at least 32 characters")


def calculate(connection, scope, body, parent_pid):
    """Contain numerical imports/work in a disposable child; never reuse a cancelled process."""
    try:
        if sys.platform == "linux":
            # A hard-killed supervisor must not leave an orphan consuming CPU.
            if ctypes.CDLL(None).prctl(1, signal.SIGKILL) != 0:
                raise RuntimeError("Cannot establish parent-death protection")
            if os.getppid() != parent_pid:
                os._exit(1)
            resource.setrlimit(resource.RLIMIT_AS, (640 * 1024**2, 640 * 1024**2))
        resource.setrlimit(resource.RLIMIT_CPU, (60, 65))
        for name in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
            os.environ[name] = "1"
        from .app import app as numerical_app

        async def invoke():
            status, chunks, size = 500, [], 0
            received = False

            async def receive():
                nonlocal received
                if not received:
                    received = True
                    return {"type": "http.request", "body": body, "more_body": False}
                # Let Starlette's disconnect listener wait while the response is sent.
                await asyncio.Future()

            async def send(message):
                nonlocal status, size
                if message["type"] == "http.response.start":
                    status = message["status"]
                elif message["type"] == "http.response.body":
                    chunk = message.get("body", b"")
                    size += len(chunk)
                    if size > MAX_OUTPUT:
                        raise ValueError("Calculation output exceeds limit")
                    chunks.append(chunk)

            await numerical_app(scope, receive, send)
            return status, b"".join(chunks)

        status, output = asyncio.run(invoke())
        connection.send_bytes(status.to_bytes(2, "big") + output)
    except BaseException:
        # Child errors may contain request data; never serialize exceptions or tracebacks.
        try:
            connection.send_bytes(b'\x01\xf7{"detail":"Calculation worker unavailable"}')
        except (OSError, BrokenPipeError):
            pass
    finally:
        connection.close()


async def reply(send, status, value):
    """Return a minimal bounded JSON response, including busy/timeout failures."""
    body = value if isinstance(value, bytes) else json.dumps(value).encode()
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json"), (b"cache-control", b"no-store")]})
    await send({"type": "http.response.body", "body": body})


class CalculationSupervisor:
    """Reject excess work instead of building an unbounded in-memory queue."""

    def __init__(self):
        self.busy = False

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                elif message["type"] == "lifespan.shutdown":
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        if scope["type"] != "http":
            return
        if scope["path"] == "/health" and scope["method"] == "GET":
            await reply(send, 200, {"status": "ok", "engineVersion": ENGINE_VERSION, "busy": self.busy})
            return
        headers = dict(scope.get("headers", []))
        if not hmac.compare_digest(headers.get(b"authorization", b""), f"Bearer {TOKEN}".encode()):
            await reply(send, 401, {"detail": "Calculation service authentication failed"})
            return
        if scope["method"] != "POST" or not scope["path"].startswith("/v1/"):
            await reply(send, 404, {"detail": "Not found"})
            return
        if self.busy:
            await reply(send, 503, {"detail": "Calculation worker busy; try later"})
            return
        self.busy = True  # No await between checking and acquiring this event-loop gate.
        lock = None
        process = None
        parent = child = result = disconnect = None
        try:
            lock = open(os.path.join(tempfile.gettempdir(), "nralgo-calculator.lock"), "a")
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                await reply(send, 503, {"detail": "Calculation worker busy; try later"})
                return
            deadline = time.monotonic() + WALL_SECONDS
            body = bytearray()
            while True:
                message = await asyncio.wait_for(receive(), max(0.01, deadline - time.monotonic()))
                if message["type"] == "http.disconnect":
                    return
                body.extend(message.get("body", b""))
                if len(body) > MAX_INPUT:
                    await reply(send, 413, {"detail": "Calculation request too large"})
                    return
                if not message.get("more_body", False):
                    break
            context = multiprocessing.get_context("spawn")
            parent, child = context.Pipe(duplex=False)
            # Copy serializable request fields only; do not pass Uvicorn state or server objects.
            child_scope = {key: scope[key] for key in
                           ("type", "asgi", "http_version", "method", "scheme", "path", "raw_path",
                            "query_string", "root_path", "headers", "client", "server") if key in scope}
            process = context.Process(target=calculate, args=(child, child_scope, bytes(body), os.getpid()), daemon=True)
            process.start()
            child.close()
            result = asyncio.create_task(asyncio.to_thread(parent.recv_bytes, MAX_OUTPUT + 2))

            async def disconnected():
                while (await receive())["type"] != "http.disconnect":
                    pass

            disconnect = asyncio.create_task(disconnected())
            done, _ = await asyncio.wait({result, disconnect}, timeout=max(0.01, deadline - time.monotonic()),
                                         return_when=asyncio.FIRST_COMPLETED)
            if disconnect in done:
                return
            if result not in done:
                await reply(send, 504, {"detail": "Calculation time limit exceeded"})
                return
            packet = result.result()
            if len(packet) < 2:
                raise ValueError("Missing calculation result")
            await reply(send, int.from_bytes(packet[:2], "big"), packet[2:])
        except asyncio.TimeoutError:
            await reply(send, 408, {"detail": "Calculation request timed out"})
        except (EOFError, OSError, ValueError):
            await reply(send, 503, {"detail": "Calculation worker stopped before completion"})
        finally:
            if process is not None and process.pid is not None:
                if process.is_alive():
                    process.terminate()
                await asyncio.to_thread(process.join, 1)
                if process.is_alive():
                    process.kill()
                    await asyncio.to_thread(process.join, 1)
                process.close()
            if disconnect:
                disconnect.cancel()
                await asyncio.gather(disconnect, return_exceptions=True)
            if child:
                child.close()
            if result:
                await asyncio.gather(result, return_exceptions=True)
            if parent:
                parent.close()
            if lock:
                lock.close()
            self.busy = False


app = CalculationSupervisor()
