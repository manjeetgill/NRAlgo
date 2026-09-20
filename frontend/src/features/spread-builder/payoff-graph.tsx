"use client";
import { useId, useState } from "react";
export type PayoffPoint = {
  spot: number;
  expiry: number;
  scenario: number;
};
const money = (value: number) =>
  new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(value);
/** Real-price x coordinates preserve strike spacing; separate expiry and model curves. */
export function PayoffGraph({
  points,
  target,
  onTarget,
}: {
  points: PayoffPoint[];
  target: number;
  onTarget: (spot: number) => void;
}) {
  const id = useId().replaceAll(":", "");
  const [hover, setHover] = useState<number | null>(null);
  const low = points[0].spot,
    high = points.at(-1)!.spot;
  const values = points.flatMap((p) => [p.expiry, p.scenario]);
  const bottom = Math.min(0, ...values),
    top = Math.max(1, ...values),
    pad = (top - bottom) * 0.12;
  const min = bottom - pad,
    max = top + pad;
  const x = (spot: number) => 78 + ((spot - low) / (high - low)) * 660;
  const y = (pnl: number) => 300 - ((pnl - min) / (max - min)) * 260;
  const line = (key: "expiry" | "scenario") =>
    points.map((p) => `${x(p.spot)},${y(p[key])}`).join(" ");
  const area = `M ${x(low)} ${y(0)} L ${line("expiry").replaceAll(" ", " L ")} L ${x(high)} ${y(0)} Z`;
  const cursor = hover ?? target;
  const nearest = points.reduce((a, b) =>
    Math.abs(a.spot - cursor) < Math.abs(b.spot - cursor) ? a : b,
  );
  return (
    <div
      style={{ overflowX: "auto" }}
      tabIndex={0}
      aria-label="Payoff chart; scroll horizontally on small screens"
    >
      <svg
        viewBox="0 0 780 354"
        role="img"
        aria-label="Strategy payoff graph: expiry and target-date P&L"
        style={{
          width: "100%",
          minWidth: 580,
          display: "block",
          touchAction: "pan-x pan-y",
        }}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const px = ((event.clientX - rect.left) / rect.width) * 780;
          setHover(
            Math.max(
              low,
              Math.min(high, low + ((px - 78) / 660) * (high - low)),
            ),
          );
        }}
        onPointerLeave={() => setHover(null)}
        onClick={() => {
          if (hover !== null) {
            onTarget(Math.round(hover * 100) / 100);
          }
        }}
      >
        <defs>
          <clipPath id={`${id}-positive`}>
            <rect x="78" y="0" width="660" height={y(0)} />
          </clipPath>
          <clipPath id={`${id}-negative`}>
            <rect x="78" y={y(0)} width="660" height={354 - y(0)} />
          </clipPath>
        </defs>
        {[0, 1, 2, 3, 4].map((i) => {
          const value = min + ((max - min) * i) / 4;
          return (
            <g key={i}>
              <line
                x1="78"
                x2="738"
                y1={y(value)}
                y2={y(value)}
                stroke="var(--border-subtle)"
              />
              <text
                x="68"
                y={y(value) + 4}
                textAnchor="end"
                fontSize="11"
                fontFamily="var(--font-mono)"
                fill="var(--text-muted)"
              >
                {money(value)}
              </text>
            </g>
          );
        })}
        <path
          d={area}
          fill="var(--success-muted)"
          clipPath={`url(#${id}-positive)`}
        />
        <path
          d={area}
          fill="var(--danger-muted)"
          clipPath={`url(#${id}-negative)`}
        />
        <line
          x1="78"
          x2="738"
          y1={y(0)}
          y2={y(0)}
          stroke="var(--border-strong)"
          strokeDasharray="4 4"
        />
        <polyline
          points={line("expiry")}
          fill="none"
          stroke="var(--success)"
          strokeWidth="2.5"
          clipPath={`url(#${id}-positive)`}
        />
        <polyline
          points={line("expiry")}
          fill="none"
          stroke="var(--danger)"
          strokeWidth="2.5"
          clipPath={`url(#${id}-negative)`}
        />
        <polyline
          points={line("scenario")}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2.5"
          strokeDasharray="6 4"
        />
        <line
          x1={x(cursor)}
          x2={x(cursor)}
          y1="40"
          y2="300"
          stroke="var(--text-muted)"
          strokeDasharray="3 5"
        />
        {[0, 1, 2, 3, 4].map((i) => {
          const price = low + ((high - low) * i) / 4;
          return (
            <text
              key={i}
              x={x(price)}
              y="320"
              textAnchor="middle"
              fontSize="11"
              fontFamily="var(--font-mono)"
              fill="var(--text-muted)"
            >
              {money(price)}
            </text>
          );
        })}
        <text
          x="400"
          y="348"
          textAnchor="middle"
          fontSize="12"
          fill="var(--text-muted)"
        >
          Underlying price (₹)
        </text>
        <text x="78" y="20" fontSize="12" fill="var(--text-muted)">
          Profit / loss (₹)
        </text>
      </svg>
      <div
        style={{
          fontSize: 12,
          display: "flex",
          gap: 16,
          flexWrap: "wrap",
          justifyContent: "center",
          fontFamily: "var(--font-mono)",
          color: "var(--text-secondary)",
        }}
      >
        <span>Spot ₹{money(nearest.spot)}</span>
        <span>Expiry ₹{money(nearest.expiry)}</span>
        <span style={{ color: "var(--accent-text)" }}>
          Target date ₹{money(nearest.scenario)}
        </span>
      </div>
    </div>
  );
}
