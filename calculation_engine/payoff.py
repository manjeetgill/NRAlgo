"""Vectorized option payoff, Black–Scholes scenario and portfolio Greeks."""

from __future__ import annotations

import numpy as np
from scipy.optimize import brentq
from scipy.stats import norm

from .contracts import (
    OptionGreekContract,
    OptionGreeksRequest,
    OptionLeg,
    PayoffRequest,
)


def _normal_cdf(value: np.ndarray) -> np.ndarray:
    """Evaluate the standard-normal CDF with SciPy's tested implementation."""
    return norm.cdf(value)


def _normal_pdf(value: np.ndarray) -> np.ndarray:
    """Evaluate the standard-normal density with SciPy's tested implementation."""
    return norm.pdf(value)


def option_payoff(
    legs: list[OptionLeg], spots: np.ndarray, total_fees: float = 0
) -> np.ndarray:
    """Evaluate signed intrinsic settlement less paid/received premiums."""
    total = np.zeros_like(spots, dtype=np.float64)
    for leg in legs:
        intrinsic = np.maximum(
            0.0,
            spots - leg.strike if leg.right == "call" else leg.strike - spots,
        )
        total += (1 if leg.side == "buy" else -1) * leg.quantity * (
            intrinsic - leg.premium
        )
    return total - total_fees


def summarize_payoff(
    legs: list[OptionLeg], total_fees: float = 0
) -> dict[str, object]:
    """Derive analytic finite breakpoints, tail exposure and expiry extrema."""
    spots = np.array(sorted({0.0, *(leg.strike for leg in legs)}), dtype=np.float64)
    values = option_payoff(legs, spots, total_fees)
    tail = sum(
        (1 if leg.side == "buy" else -1) * leg.quantity
        for leg in legs
        if leg.right == "call"
    )
    roots: set[float] = set()
    for index, spot in enumerate(spots):
        if values[index] == 0:
            roots.add(float(spot))
        if index and values[index - 1] * values[index] < 0:
            roots.add(
                float(
                    spots[index - 1]
                    - values[index - 1]
                    * (spots[index] - spots[index - 1])
                    / (values[index] - values[index - 1])
                )
            )
    if tail and -values[-1] / tail > 0:
        roots.add(float(spots[-1] - values[-1] / tail))
    return {
        "maxProfit": None if tail > 0 else float(np.max(values)),
        "maxLoss": None if tail < 0 else float(max(0.0, -np.min(values))),
        "unlimitedProfit": tail > 0,
        "unlimitedLoss": tail < 0,
        "breakevens": sorted(roots),
    }


def _black_scholes(
    spot: np.ndarray,
    leg: OptionLeg,
    days: float,
    rate: float,
    dividend: float,
    iv_shift: float,
) -> dict[str, np.ndarray]:
    """Return vectorized European mark and Greeks using SciPy's normal CDF/PDF."""
    sign = 1.0 if leg.right == "call" else -1.0
    volatility = max(0.0, leg.iv + iv_shift)
    if days == 0:
        intrinsic = np.maximum(0.0, sign * (spot - leg.strike))
        delta = np.where(
            spot == leg.strike,
            sign * 0.5,
            np.where(sign * (spot - leg.strike) > 0, sign, 0.0),
        )
        zeros = np.zeros_like(spot)
        return {"price": intrinsic, "delta": delta, "gamma": zeros, "theta": zeros, "vega": zeros}
    years = days / 365.0
    spot_discounted = spot * np.exp(-dividend * years)
    strike_discounted = leg.strike * np.exp(-rate * years)
    if volatility == 0:
        in_money = sign * (spot_discounted - strike_discounted) > 0
        return {
            "price": np.maximum(0.0, sign * (spot_discounted - strike_discounted)),
            "delta": np.where(in_money, sign * np.exp(-dividend * years), 0.0),
            "gamma": np.zeros_like(spot),
            "theta": np.where(
                in_money,
                sign
                * (dividend * spot_discounted - rate * strike_discounted)
                / 365.0,
                0.0,
            ),
            "vega": np.zeros_like(spot),
        }
    root = np.sqrt(years)
    d1 = (
        np.log(spot / leg.strike)
        + (rate - dividend + volatility**2 / 2) * years
    ) / (volatility * root)
    d2 = d1 - volatility * root
    return {
        "price": np.maximum(
            0.0,
            sign
            * (
                spot_discounted * _normal_cdf(sign * d1)
                - strike_discounted * _normal_cdf(sign * d2)
            ),
        ),
        "delta": sign * np.exp(-dividend * years) * _normal_cdf(sign * d1),
        "gamma": np.exp(-dividend * years) * _normal_pdf(d1) / (spot * volatility * root),
        "theta": (
            -spot_discounted * _normal_pdf(d1) * volatility / (2 * root)
            - sign * rate * strike_discounted * _normal_cdf(sign * d2)
            + sign * dividend * spot_discounted * _normal_cdf(sign * d1)
        )
        / 365.0,
        "vega": spot_discounted * _normal_pdf(d1) * root / 100.0,
    }


def _black_76(
    forward: float,
    contract: OptionGreekContract,
    days: float,
    rate: float,
    volatility: float,
) -> dict[str, float]:
    """Return a Black-76 index-option mark and Greeks from a synthetic forward."""
    sign = 1.0 if contract.right == "call" else -1.0
    years = days / 365.0
    root = np.sqrt(years)
    discount = np.exp(-rate * years)
    d1 = (
        np.log(forward / contract.strike) + volatility**2 * years / 2.0
    ) / (volatility * root)
    d2 = d1 - volatility * root
    price = discount * sign * (
        forward * norm.cdf(sign * d1)
        - contract.strike * norm.cdf(sign * d2)
    )
    density = norm.pdf(d1)
    return {
        "price": float(max(0.0, price)),
        "delta": float(sign * discount * norm.cdf(sign * d1)),
        "gamma": float(discount * density / (forward * volatility * root)),
        "theta": float(
            (rate * price - discount * forward * density * volatility / (2.0 * root))
            / 365.0
        ),
        "vega": float(discount * forward * density * root / 100.0),
    }


def _implied_volatility(
    forward: float,
    contract: OptionGreekContract,
    days: float,
    rate: float,
) -> float | None:
    """Invert one Black-76 premium with SciPy's bounded Brent solver."""
    low = 0.0001
    high = 5.0
    low_mark = _black_76(forward, contract, days, rate, low)["price"]
    high_mark = _black_76(forward, contract, days, rate, high)["price"]
    if contract.premium < low_mark or contract.premium > high_mark:
        return None
    # A rounded near-intrinsic premium cannot identify volatility reliably.
    if contract.premium - low_mark <= 0.01:
        return None
    try:
        volatility = float(brentq(
            lambda volatility: _black_76(
                forward, contract, days, rate, volatility
            )["price"]
            - contract.premium,
            low,
            high,
            xtol=1e-12,
            maxiter=100,
        ))
    except (ValueError, RuntimeError):
        # One corrupt/unbracketed contract must not discard the rest of the chain.
        return None
    # Vega is rupees per one percentage point of volatility. A 0.1-point
    # change smaller than one paisa is not identifiable from rounded premiums.
    vega = _black_76(forward, contract, days, rate, volatility)["vega"]
    if not np.isfinite(volatility) or not np.isfinite(vega) or vega <= 0.1:
        return None
    return volatility


def calculate_option_greeks(payload: OptionGreeksRequest) -> dict[str, object]:
    """Return per-contract IV and Greeks derived from the exact observed premium.

    Index-option analytics use a synthetic forward derived from the closest
    strike's call/put parity. This avoids incorrectly applying spot carry twice
    and keeps paired call/put theta consistent. The closest listed strike uses
    the conventional chain delta of +0.5/-0.5.
    """
    atm_strike = min(
        {contract.strike for contract in payload.contracts},
        key=lambda strike: (abs(strike - payload.spot), strike),
    )
    atm_contracts = {
        contract.right: contract
        for contract in payload.contracts
        if contract.strike == atm_strike
    }
    years = payload.days / 365.0
    if "call" in atm_contracts and "put" in atm_contracts:
        forward = atm_strike + np.exp(payload.rate * years) * (
            atm_contracts["call"].premium - atm_contracts["put"].premium
        )
    else:
        forward = payload.spot * np.exp(
            (payload.rate - payload.dividend) * years
        )
    results: list[dict[str, float | str | None]] = []
    for contract in payload.contracts:
        volatility = _implied_volatility(
            float(forward),
            contract,
            payload.days,
            payload.rate,
        )
        if volatility is None:
            results.append(
                {
                    "key": contract.key,
                    "impliedVolatility": None,
                    "delta": None,
                    "gamma": None,
                    "theta": None,
                    "vega": None,
                }
            )
            continue
        values = _black_76(
            float(forward), contract, payload.days, payload.rate, volatility
        )
        model_delta = values["delta"]
        display_delta = (
            0.5 if contract.right == "call" else -0.5
        ) if contract.strike == atm_strike else model_delta
        results.append(
            {
                "key": contract.key,
                "impliedVolatility": volatility * 100.0,
                "delta": display_delta,
                "gamma": values["gamma"],
                "theta": values["theta"],
                "vega": values["vega"],
            }
        )
    return {"model": "black-76-synthetic-forward-v1", "items": results}


def calculate_payoff(request: PayoffRequest) -> dict[str, object]:
    """Calculate one bounded grid and exact target scenario in a single service call."""
    risk = summarize_payoff(request.legs, request.totalFees)
    low = max(0.01, min(request.spot * 0.8, *(leg.strike * 0.9 for leg in request.legs)))
    high = max(request.spot * 1.2, *(leg.strike * 1.1 for leg in request.legs))
    if not low <= request.targetSpot <= high:
        raise ValueError(f"Target price must be between {low:.2f} and {high:.2f}.")
    prices = np.array(
        sorted(
            {
                *np.linspace(low, high, 161).tolist(),
                *(leg.strike for leg in request.legs),
                *(root for root in risk["breakevens"] if low <= root <= high),
            }
        ),
        dtype=np.float64,
    )
    expiry = option_payoff(request.legs, prices, request.totalFees)
    totals = {name: np.zeros_like(prices) for name in ("pnl", "delta", "gamma", "theta", "vega")}
    target = {name: 0.0 for name in totals}
    for leg in request.legs:
        units = (1 if leg.side == "buy" else -1) * leg.quantity
        marks = _black_scholes(
            prices,
            leg,
            request.days,
            request.rate,
            request.dividend,
            request.ivShift,
        )
        target_marks = _black_scholes(
            np.array([request.targetSpot]),
            leg,
            request.days,
            request.rate,
            request.dividend,
            request.ivShift,
        )
        totals["pnl"] += units * (marks["price"] - leg.premium)
        target["pnl"] += units * (float(target_marks["price"][0]) - leg.premium)
        for name in ("delta", "gamma", "theta", "vega"):
            totals[name] += units * marks[name]
            target[name] += units * float(target_marks[name][0])
    totals["pnl"] -= request.totalFees
    target["pnl"] -= request.totalFees
    return {
        "risk": risk,
        # Signed entry premium: positive debit, negative credit; fees stay separate.
        "netDebit": sum(
            (1 if leg.side == "buy" else -1) * leg.premium * leg.quantity
            for leg in request.legs
        ),
        "low": low,
        "high": high,
        "points": [
            {
                "spot": float(price),
                "expiry": float(expiry[index]),
                "scenario": float(totals["pnl"][index]),
            }
            for index, price in enumerate(prices)
        ],
        "target": {name: float(value) for name, value in target.items()},
        "targetExpiry": float(
            option_payoff(
                request.legs,
                np.array([request.targetSpot]),
                request.totalFees,
            )[0]
        ),
    }
