"""Offline active-reference checks; no broker, database or network access."""
import importlib.util
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

spec = importlib.util.spec_from_file_location("fno_download", Path(__file__).resolve().parents[1] / "scripts/download_fno_historical.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ActiveOptionReferenceTests(unittest.TestCase):
    def reference(self, folder, rows):
        path = Path(folder) / "reference.csv"
        path.write_text("day,underlying,expiry_date,right,strike_price\n" + rows)
        return path

    def test_exact_identities_and_expiry_boundary(self):
        with TemporaryDirectory() as folder:
            path = self.reference(folder, "2026-09-18,NIFTY,2026-09-19,call,25000\n2026-09-18,NIFTY,2026-09-20,call,25000\n2026-09-18,NIFTY,2026-09-24,put,25000\n2026-09-18,ABC,2026-09-24,call,100\n")
            keys, metadata = module.active_contracts(path, date(2026, 9, 20))
            self.assertEqual(len(keys), 3)
            self.assertNotIn(("NIFTY", "2026-09-19", "call", "25000"), keys)
            self.assertIn(("NIFTY", "2026-09-20", "call", "25000"), keys)
            self.assertEqual(metadata["contracts"], 3)
            self.assertEqual(metadata["sha256"], module.sha256(path.read_bytes()))
            _, changed = module.active_contracts(path, date(2026, 9, 21))
            self.assertNotEqual(metadata, changed)

    def test_rejects_empty_expired_future_mixed_and_invalid_reference(self):
        cases = ["", "2026-09-18,NIFTY,2026-09-19,call,25000\n", "2026-09-21,NIFTY,2026-09-24,call,25000\n", "2026-09-18,NIFTY,2026-09-24,call,25000\n2026-09-17,NIFTY,2026-09-24,put,25000\n", "2026-09-18,NIFTY,2026-09-24,invalid,25000\n"]
        with TemporaryDirectory() as folder:
            for rows in cases:
                with self.subTest(rows=rows):
                    path = self.reference(folder, rows)
                    with self.assertRaises(module.ArchiveValidationError):
                        module.active_contracts(path, date(2026, 9, 20))


if __name__ == "__main__":
    unittest.main()
