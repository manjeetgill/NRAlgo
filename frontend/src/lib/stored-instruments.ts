/** Runtime contracts for operator-imported instruments that have stored daily candles. */
import { z } from "zod";

export const storedInstrumentSchema = z.object({
  id: z.string().min(1).max(120),
  symbol: z.string().min(1).max(60),
  name: z.string().min(1).max(160),
  kind: z.enum(["equity", "index"]),
  series: z.string().max(10),
  exchange: z.literal("NSE"),
  first_day: z.iso.date(),
  last_day: z.iso.date(),
  candle_count: z.number().int().positive(),
});
export const storedInstrumentSearchSchema = z.object({
  items: z.array(storedInstrumentSchema),
  nextOffset: z.number().int().nonnegative().nullable(),
});
export type StoredInstrument = z.infer<typeof storedInstrumentSchema>;
export type StoredInstrumentSearch = z.infer<
  typeof storedInstrumentSearchSchema
>;
