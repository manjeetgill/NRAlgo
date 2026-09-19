/** Public attribution for the Apache-2.0 chart renderer. Broker data rights remain separate. */
export default function ChartingAttributionPage() {
  return (
    <main style={{ maxWidth: 760, margin: "4rem auto", padding: "2rem" }}>
      <h1>Charting attribution</h1>
      <h2>KLineChart</h2>
      <p>
        Copyright (c) 2019 lihu. Used under the{" "}
        <a href="https://github.com/klinecharts/KLineChart/blob/main/LICENSE">
          Apache License 2.0
        </a>
        . KLineChart’s NOTICE also credits TradingView Lightweight Charts,
        Copyright (c) 2019 TradingView, Inc.
      </p>
      <p>
        Historical data is imported separately. Data-use rights and data quality
        remain separate from the chart renderer license. This is not
        TradingView’s hosted chart or market-data feed.
      </p>
    </main>
  );
}
