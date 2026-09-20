"use client";
/** Rule catalog contains no market data, generated results or execution permissions. */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { strategyTemplates, type TemplateId } from "./strategy-templates";

/** Present reproducible rules and route explicit configuration intent to the separate backtest workflow. */
export function StrategyLibraryScreen({
  onConfigure,
}: {
  onConfigure?: (id: TemplateId) => void;
}) {
  const [selected, setSelected] = useState<TemplateId | null>(null);
  const toast = useToast();
  return (
    <section
      className="screen-stack strategy-library-screen"
      aria-label="Strategy template library"
    >
      <div className="environment">
        <div>
          <strong>Build from rules, validate with evidence</strong>
          <span>
            Transparent rules, explicit fill assumptions and your historical
            data. No profitability claims.
          </span>
        </div>
        <Badge tone="accent">3 rule templates</Badge>
      </div>
      <div className="screen-two-columns">
        {strategyTemplates.map((template) => (
          <article key={template.id} className="panel screen-card">
            <div className="screen-toolbar">
              <h2>{template.name}</h2>
              <Badge tone="neutral">v1.0</Badge>
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
                onClick={() => {
                  if (onConfigure) {
                    onConfigure(template.id);
                    toast({
                      tone: "info",
                      title: "Opening Backtest Studio",
                      description: `${template.name} loaded for configuration.`,
                    });
                  } else {
                    setSelected(template.id);
                  }
                }}
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
      </div>
      <details className="panel screen-card">
        <summary>Reference only · Hilega Milega (not runnable)</summary>
        <Badge tone="warning">Needs rule confirmation</Badge>
        <p>
          A reproducible specification has not been supplied. This strategy
          cannot run yet.
        </p>
        <p>
          Required: indicator periods and sources, crossover sequence, swing
          definition, entry timing, short rules, stops and exits.
        </p>
      </details>
      <article className="panel screen-card">
        <h2>Strategy workflow</h2>
        <p>
          Define rules → validate parameters → backtest historical data → review
          results → separately authorize execution.
        </p>
        <p>
          Backtests are research, not live deployment or order authorization.
        </p>
      </article>
    </section>
  );
}
