"""Vectorized option payoff, Black–Scholes scenario and portfolio Greeks."""

from __future__ import annotations

from math import erf, pi

import numpy as np

from .contracts import OptionLeg, PayoffRequest


def _normal_cdf(value: np.ndarray) -> np.ndarray:
    """Evaluate the standard-normal CDF on a small bounded scenario grid."""
    return 0.5 * (1 + np.vectorize(erf)(value / np.sqrt(2.0)))


def _normal_pdf(value: np.ndarray) -> np.ndarray:
    """Evaluate the standard-normal density without a heavyweight optimizer stack."""
    return np.exp(-(value**2) / 2) / np.sqrt(2 * pi)


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
