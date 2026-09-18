"use client";
/** Rule catalog contains no market data, generated results or execution permissions. */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { strategyTemplates, type TemplateId } from "./strategy-templates";

/** Present reproducible rules and route explicit configuration intent to the separate backtest workflow. */
export function StrategyLibraryScreen({
  onConfigure,
}: {
  onConfigure?: (id: TemplateId) => void;
}) {
  const [selected, setSelected] = useState<TemplateId | null>(null);
  return (
    <section className="screen-stack" aria-label="Strategy template library">
      <div className="environment">
        <div>
          <strong>Build from rules, validate with evidence</strong>
          <span>
            Transparent rules, explicit fill assumptions and your historical
            data. No profitability claims.
          </span>
        </div>
        <span className="badge">3 rule templates</span>
      </div>
      <div className="screen-two-columns">
        {strategyTemplates.map((template) => (
          <article key={template.id} className="panel screen-card">
            <div className="screen-toolbar">
              <h2>{template.name}</h2>
              <span className="badge">v1.0</span>
            </div>
            <p>{template.category}</p>
            <p>
              <strong>Entry:</strong> {template.entry}
            </p>
            <p>
              <strong>Exit:</strong> {template.exit}
            </p>
            <div className="screen-toolbar">
              <p>Cash equity · daily bars · long only</p>
              <Button
                onClick={() =>
                  onConfigure
                    ? onConfigure(template.id)
                    : setSelected(template.id)
                }
              >
                {onConfigure ? "Configure & backtest" : "Inspect parameters"}
              </Button>
            </div>
            {selected === template.id && (
              <p>
                {template.first}: {template.defaults[0]} · {template.second}:{" "}
                {template.defaults[1]}. Supply historical OHLC data before
                calculating results.
              </p>
            )}
          </article>
        ))}
        <article className="panel screen-card">
          <h2>Hilega Milega reference</h2>
          <span className="badge">Needs rule confirmation</span>
          <p>
            A reproducible specification has not been supplied. This strategy
            cannot run yet.
          </p>
          <p>
            Required: indicator periods and sources, crossover sequence, swing
            definition, entry timing, short rules, stops and exits.
          </p>
        </article>
      </div>
      <article className="panel screen-card">
        <h2>Strategy workflow</h2>
        <p>
          Define rules → validate parameters → backtest historical data → review
          results → separately authorize execution.
        </p>
        <p>
          AI rule extraction and automatic strategy deployment are not
          connected. Research does not grant permission to submit broker orders.
        </p>
      </article>
    </section>
  );
}
