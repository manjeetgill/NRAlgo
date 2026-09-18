/** Tiny documented master schemas for offline tests. No public download or broker session. */
import AdmZip from "adm-zip";
import { InstrumentCatalog } from "../../dist/backend/instrument-master.js";
export const optionExpiry = "2026-09-24";
export const iciciCashCsv =
  'Token,ShortName,Series,CompanyName,Lotsize\n100,TEST,EQ,"Test, Limited",1\n';
export const iciciOptionCsv =
  "Token,ShortName,InstrumentName,ExpiryDate,StrikePrice,OptionType,LotSize,CompanyName\n200,TEST,OPTIDX,24-Sep-2026,25000,CE,25,Test\n201,TEST,OPTIDX,24-Sep-2026,25000,PE,25,Test\n";
export const kotakCashCsv =
  "pSymbol,pExchSeg,pSymbolName,pTrdSymbol,lLotSize,pGroup\n123,nse_cm,TEST,TEST-EQ,1,EQ\n";
const expiryEpoch =
  Date.parse(`${optionExpiry}T15:30:00+05:30`) / 1000 - 315511200;
export const kotakOptionCsv = `pSymbol,pExchSeg,pSymbolName,pTrdSymbol,lLotSize,pInstType,pOptionType,lExpiryDate ,dStrikePrice;,lPrecision\n123,nse_fo,TEST,TEST26SEP25000CE,25,OPTIDX,CE,${expiryEpoch},2500000,2\n124,nse_fo,TEST,TEST26SEP25000PE,25,OPTIDX,PE,${expiryEpoch},2500000,2\n`;
export function fakeInstrumentCatalog(downloads = []) {
  return new InstrumentCatalog(async (url) => {
    downloads.push(url);
    if (url.endsWith(".zip")) {
      const zip = new AdmZip();
      zip.addFile("NSEScripMaster.txt", Buffer.from(iciciCashCsv));
      zip.addFile("FONSEScripMaster.txt", Buffer.from(iciciOptionCsv));
      return zip.toBuffer();
    }
    return Buffer.from(
      url.endsWith("nse_fo.csv") ? kotakOptionCsv : kotakCashCsv,
    );
  });
}
