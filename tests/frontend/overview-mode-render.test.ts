/** Server-render both modes offline. Effects do not run, so no account/broker API is contacted. */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { createElement } from "../../frontend/node_modules/react/index.js";
import { renderToStaticMarkup } from "../../frontend/node_modules/react-dom/server.node.js";

// A test-only CSS loader supplies class names; production styling remains handled by Next.js.
register(
  `data:text/javascript,${encodeURIComponent(`
  /** Ignore stylesheet bytes in text/visibility assertions, delegating every other module normally. */
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.module.css')) {
      return { format: 'module', shortCircuit: true, source: 'export default new Proxy({}, { get: (_, key) => String(key) });' };
    }
    return nextLoad(url, context);
  }
`)}`,
  import.meta.url,
);
const { OverviewScreen } =
  await import("../../frontend/src/features/overview/overview-screen");

/** Render a representative audit and research book; callbacks cannot trigger navigation during SSR. */
function renderOverview(paperTradingEnabled: boolean) {
  return renderToStaticMarkup(
    createElement(OverviewScreen, {
      workspace: {
        csrf: "test-csrf",
        halted: false,
        live_configured: false,
        paper_trading_enabled: paperTradingEnabled,
        strategies: [],
        jobs: [{ id: "1", status: "running" }],
        events: [
          {
            id: 1,
            message: "Paper workspace initialized.",
            created_at: "2026-09-18T10:00:00Z",
          },
        ],
      },
      /** Navigation is deliberately inert in static rendering assertions. */
      onNavigate: () => {},
      /** Market navigation is also inert; these tests must never open a browser or call an API. */
      onExploreOptionChain: () => {},
    }),
  );
}

test("live Overview markup contains no paper UI, virtual balance, replay card or simulator activity", /** Assert actual rendered markup, not just navigation helper outputs. */ () => {
  const markup = renderOverview(false);
  assert.match(markup, /Live position P&amp;L/);
  assert.match(markup, /Available margin/);
  assert.match(markup, /Open live trading/);
  assert.doesNotMatch(markup, /paper|simulated|virtual|replay/i);
});

test("paper Overview markup restores the simulator without live-account controls", /** The enabled setting must still expose the complete paper orientation screen. */ () => {
  const markup = renderOverview(true);
  assert.match(markup, /Paper P&amp;L/);
  assert.match(markup, /Running replays/);
  assert.match(markup, /Available virtual cash/);
  assert.match(markup, /Paper workspace initialized/);
  assert.doesNotMatch(
    markup,
    /Live position P&amp;L|Open live trading|Available margin/,
  );
});
