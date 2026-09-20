/** Owner-scoped watchlists use exact historical-catalog identities, never broker order tokens. */
import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store, Query } from "./database.js";
import type { HistoricalCandleStore } from "./historical-candle-store.js";
import { fail } from "./security.js";

const entrySchema = z.object({
  id: z.string().max(120).nullable(),
  symbol: z.string().max(60),
  name: z.string().max(160),
});
const entriesSchema = z.array(entrySchema).max(100);
const nameSchema = z.string().trim().min(1).max(40);
type Watchlist = {
  id: string;
  name: string;
  is_default: boolean;
  items: unknown;
};
export function registerWatchlistRoutes(
  app: Express,
  store: Store,
  history: HistoricalCandleStore,
) {
  async function lock(query: Query, owner: string, id: string) {
    // Serialize mutations and list-count limits for this owner only.
    await query(
      "SELECT user_id FROM user_settings WHERE user_id=$1 FOR UPDATE",
      [owner],
    );
    const [row] = await query<Watchlist>(
      "SELECT id,name,is_default,items FROM watchlists WHERE user_id=$1 AND id=$2 FOR UPDATE",
      [owner, id],
    );
    if (!row) {
      return fail(404, "Watchlist not found.");
    }
    return row;
  }
  app.get("/api/watchlists", async (_req, res) => {
    const owner = res.locals.session.user_id;
    const hasDefault = await store.transaction((query) =>
      query("SELECT id FROM watchlists WHERE user_id=$1 AND is_default", [
        owner,
      ]),
    );
    // Do not hold a database connection while the archive/fallback catalog performs its own reads.
    const matches = hasDefault.length
      ? []
      : await history.searchInstruments("NIFTY", 0);
    const lists = await store.transaction(async (query) => {
      await query(
        "SELECT user_id FROM user_settings WHERE user_id=$1 FOR UPDATE",
        [owner],
      );
      let rows = await query<Watchlist>(
        "SELECT id,name,is_default,items FROM watchlists WHERE user_id=$1 ORDER BY is_default DESC,created_at,id",
        [owner],
      );
      if (!rows.some((row) => row.is_default)) {
        const defaults = [
          { symbol: "NIFTY 50", aliases: ["NIFTY 50", "NIFTY", "NIFTY50"] },
          {
            symbol: "NIFTY BANK",
            aliases: ["NIFTY BANK", "BANKNIFTY", "NIFTYBANK"],
          },
        ].map(({ symbol, aliases }) => {
          const found = matches.find(
            (row) =>
              row.kind === "index" &&
              aliases.includes(row.symbol.toUpperCase()),
          );
          return {
            id: found?.id ?? null,
            symbol: found?.symbol ?? symbol,
            name: found?.name ?? symbol,
          };
        });
        const [created] = await query<Watchlist>(
          "INSERT INTO watchlists(id,user_id,name,is_default,items) VALUES($1,$2,'My watchlist',true,$3::jsonb) RETURNING id,name,is_default,items",
          [randomUUID(), owner, JSON.stringify(defaults)],
        );
        rows = [created, ...rows];
      }
      return rows.map((row) => ({
        ...row,
        items: entriesSchema.parse(row.items),
      }));
    });
    const names = await history.watchlistNames(
      lists.flatMap((list) =>
        list.items.flatMap((item) => (item.id ? [item.id] : [])),
      ),
    );
    res.json({
      lists: lists.map((list) => ({
        ...list,
        items: list.items.map((item) => ({
          ...item,
          name: (item.id && names.get(item.id)) || item.name,
        })),
      })),
    });
  });
  app.post("/api/watchlists", async (req, res) => {
    const { name } = z.object({ name: nameSchema }).strict().parse(req.body);
    const owner = res.locals.session.user_id;
    const id = randomUUID();
    await store.transaction(async (query) => {
      await query(
        "SELECT user_id FROM user_settings WHERE user_id=$1 FOR UPDATE",
        [owner],
      );
      const rows = await query(
        "SELECT id FROM watchlists WHERE user_id=$1 AND NOT is_default",
        [owner],
      );
      if (rows.length >= 9) {
        fail(409, "You can create up to 10 watchlists.");
      }
      await query(
        "INSERT INTO watchlists(id,user_id,name,is_default,items) VALUES($1,$2,$3,false,'[]'::jsonb)",
        [id, owner, name],
      );
    });
    res.status(201).json({ id });
  });
  app.delete("/api/watchlists/:id", async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    await store.transaction(async (query) => {
      const row = await lock(query, res.locals.session.user_id, id);
      if (row.is_default) {
        fail(
          409,
          "Keep the default watchlist; you can remove individual scrips.",
        );
      }
      await query("DELETE FROM watchlists WHERE user_id=$1 AND id=$2", [
        res.locals.session.user_id,
        id,
      ]);
    });
    res.json({ ok: true });
  });
  app.post("/api/watchlists/:id/items", async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const { instrumentId } = z
      .object({ instrumentId: z.string().min(1).max(120) })
      .strict()
      .parse(req.body);
    const item = await history.readInstrument(instrumentId);
    if (!item) {
      return fail(404, "Scrip is not in the stored market-data catalog.");
    }
    await store.transaction(async (query) => {
      const row = await lock(query, res.locals.session.user_id, id);
      const items = entriesSchema.parse(row.items);
      if (items.some((value) => value.id === item.id)) {
        return;
      }
      if (items.length >= 100) {
        fail(409, "A watchlist can contain up to 100 scrips.");
      }
      items.push({ id: item.id, symbol: item.symbol, name: item.name });
      await query(
        "UPDATE watchlists SET items=$3::jsonb WHERE user_id=$1 AND id=$2",
        [res.locals.session.user_id, id, JSON.stringify(items)],
      );
    });
    res.json({ ok: true });
  });
  app.delete("/api/watchlists/:id/items", async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const input = entrySchema
      .pick({ id: true, symbol: true })
      .strict()
      .parse(req.body);
    await store.transaction(async (query) => {
      const row = await lock(query, res.locals.session.user_id, id);
      const items = entriesSchema
        .parse(row.items)
        .filter(
          (item) => !(item.id === input.id && item.symbol === input.symbol),
        );
      await query(
        "UPDATE watchlists SET items=$3::jsonb WHERE user_id=$1 AND id=$2",
        [res.locals.session.user_id, id, JSON.stringify(items)],
      );
    });
    res.json({ ok: true });
  });
}
