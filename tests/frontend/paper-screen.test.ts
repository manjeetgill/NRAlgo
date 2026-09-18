/** Offline render verifies that only authentic wallet data can populate the paper screen. */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "../../frontend/node_modules/react/index.js";
import { renderToStaticMarkup } from "../../frontend/node_modules/react-dom/server.node.js";
import { PaperTradingScreen } from "../../frontend/src/features/paper-trading/paper-trading-screen";
test("paper screen starts without fabricated funds, credentials or completed trades", () => {
  const markup = renderToStaticMarkup(
    createElement(PaperTradingScreen, { csrf: "test" }),
  );
  assert.match(markup, /New order/);
  assert.match(markup, /Review paper order/);
  assert.doesNotMatch(
    markup,
    /sample|demo|SAMPLE-|accessToken|mpin|86,400|4,210/i,
  );
});
