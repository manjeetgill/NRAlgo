/** Tiny documented master schemas for offline tests. No public download or broker session. */
import { InstrumentCatalog } from "../../dist/backend/instrument-master.js";
export const optionExpiry = "2026-09-24";
export const kotakCashCsv =
  "pSymbol,pExchSeg,pSymbolName,pTrdSymbol,lLotSize,pGroup\n123,nse_cm,TEST,TEST-EQ,1,EQ\n";
const expiryEpoch =
  Date.parse(`${optionExpiry}T15:30:00+05:30`) / 1000 - 315511200;
export const kotakOptionCsv = `pSymbol,pExchSeg,pSymbolName,pTrdSymbol,lLotSize,pInstType,pOptionType,lExpiryDate ,dStrikePrice;,lPrecision\n123,nse_fo,TEST,TEST26SEP25000CE,25,OPTIDX,CE,${expiryEpoch},2500000,2\n124,nse_fo,TEST,TEST26SEP25000PE,25,OPTIDX,PE,${expiryEpoch},2500000,2\n`;
export function fakeInstrumentCatalog(downloads = []) {
  return new InstrumentCatalog(async (url) => {
    downloads.push(url);
    return Buffer.from(
      url.endsWith("nse_fo.csv") ? kotakOptionCsv : kotakCashCsv,
    );
  });
}
