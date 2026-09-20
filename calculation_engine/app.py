"""Private authenticated HTTP boundary for broker-free quantitative calculations."""

from __future__ import annotations

import hmac
import os

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

from . import ENGINE_VERSION
from .backtest import run_daily_backtest, run_stored_daily_session
from .contracts import (
    DailyBacktestRequest,
    MarketInsightRequest,
    OptionGreeksRequest,
    PayoffRequest,
    StoredDailyRequest,
)
from .market_insights import load_market_insight
from .payoff import calculate_option_greeks, calculate_payoff

MAX_REQUEST_BYTES = 8 * 1024 * 1024
TOKEN = os.environ.get("CALCULATION_SERVICE_TOKEN", "")
if len(TOKEN) < 32:
    raise RuntimeError("CALCULATION_SERVICE_TOKEN must contain at least 32 characters")

app = FastAPI(
    title="NRIAlgo calculation engine",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


@app.middleware("http")
async def bound_request_size(request: Request, call_next):
    """Reject oversized payloads before Pydantic or numerical allocation."""
    raw_length = request.headers.get("content-length")
    try:
        oversized = bool(raw_length) and int(raw_length) > MAX_REQUEST_BYTES
    except ValueError:
        return JSONResponse(status_code=400, content={"detail": "Invalid Content-Length"})
    if oversized:
        return JSONResponse(
            status_code=413, content={"detail": "Calculation request too large"}
        )
    return await call_next(request)


def authorize(authorization: str = Header(default="")) -> None:
    """Authenticate only the Node gateway using a constant-time shared token check."""
    expected = f"Bearer {TOKEN}"
    if not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="Calculation service authentication failed")


@app.get("/health")
def health() -> dict[str, str]:
    """Expose dependency health without strategy data or service credentials."""
    return {"status": "ok", "engineVersion": ENGINE_VERSION}


@app.post("/v1/backtests/daily", dependencies=[Depends(authorize)])
def daily_backtest(payload: DailyBacktestRequest) -> dict[str, object]:
    """Calculate one deterministic daily backtest."""
    try:
        return {
            "engineVersion": ENGINE_VERSION,
            "result": run_daily_backtest(payload.bars, payload.settings),
        }
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post("/v1/research/stored-daily", dependencies=[Depends(authorize)])
def stored_daily(payload: StoredDailyRequest) -> dict[str, object]:
    """Calculate independent stored-daily research sessions."""
    sessions: list[dict[str, object]] = []
    rejected: list[dict[str, str]] = []
    for candle in payload.candles:
        try:
            sessions.append(run_stored_daily_session(candle, payload.strategy))
        except ValueError as error:
            rejected.append({"day": candle.date.isoformat(), "reason": str(error)})
    if not sessions:
        raise HTTPException(
            status_code=422,
            detail=rejected[0]["reason"] if rejected else "No session could be calculated",
        )
    total_pnl = round(sum(float(session["pnl"]) for session in sessions), 2)
    return {
        "engineVersion": ENGINE_VERSION,
        "sessions": sessions,
        "rejected": rejected,
        "summary": {
            "sessions": [
                {
                    "day": session["day"],
                    "pnl": session["pnl"],
                    "drawdown": session["drawdown"],
                    "totalFees": session["totalFees"],
                    "trades": len(session["fills"]),
                }
                for session in sessions
            ],
            "sessionsRun": len(sessions),
            "winningSessions": sum(float(session["pnl"]) > 0 for session in sessions),
            "losingSessions": sum(float(session["pnl"]) < 0 for session in sessions),
            "breakEvenSessions": sum(float(session["pnl"]) == 0 for session in sessions),
            "totalPnl": total_pnl,
            "totalFees": round(sum(float(session["totalFees"]) for session in sessions), 2),
            "worstSessionDrawdown": max(float(session["drawdown"]) for session in sessions),
            "averagePnlPerSession": round(total_pnl / len(sessions), 2),
        },
    }


@app.post("/v1/options/payoff", dependencies=[Depends(authorize)])
def options_payoff(payload: PayoffRequest) -> dict[str, object]:
    """Calculate expiry payoff, target-date marks and portfolio Greeks."""
    try:
        return {"engineVersion": ENGINE_VERSION, "result": calculate_payoff(payload)}
    except ValueError as error:
        # Expected pricing-domain failures are actionable input errors, not outages.
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post("/v1/options/greeks", dependencies=[Depends(authorize)])
def option_greeks(payload: OptionGreeksRequest) -> dict[str, object]:
    """Derive bounded per-contract Greeks from observed option premiums."""
    return {"engineVersion": ENGINE_VERSION, "result": calculate_option_greeks(payload)}


@app.post("/v1/market/insights", dependencies=[Depends(authorize)])
def market_insights(payload: MarketInsightRequest) -> dict[str, object]:
    """Return one bounded public NSE reference dataset with no broker capability."""

    try:
        return load_market_insight(payload.dataset)
    except Exception as error:
        raise HTTPException(
            status_code=503,
            detail="Public NSE market reference is temporarily unavailable.",
        ) from error
