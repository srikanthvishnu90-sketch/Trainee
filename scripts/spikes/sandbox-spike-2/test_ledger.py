# 40 unittest tests for ledger.py (invented fixture).
import sqlite3, unittest
from ledger import Ledger, median, STAGES

class Base(unittest.TestCase):
    def setUp(self):
        self.l = Ledger()
        self.c = self.l.company("Acme")
        self.a = self.l.add(self.c, "Analyst", 3)

class T(Base):
    def test_new_is_saved(self): self.assertEqual(self.l.stage(self.a), "saved")
    def test_advance_same_stage_ok(self): self.l.advance(self.a, "saved"); self.assertEqual(self.l.stage(self.a), "saved")
    def test_backwards_refused(self):
        self.l.advance(self.a, "screen")
        with self.assertRaises(ValueError): self.l.advance(self.a, "applied")
    def test_unknown_app(self):
        with self.assertRaises(KeyError): self.l.advance(999, "applied")
    def test_count_all(self): self.assertEqual(self.l.count(), 1)
    def test_fk_enforced(self):
        with self.assertRaises(sqlite3.IntegrityError): self.l.add(999, "X", 1)
    def test_remove_cascades(self): self.l.remove_company(self.c); self.assertEqual(self.l.count(), 0)
    def test_unique_company(self):
        with self.assertRaises(sqlite3.IntegrityError): self.l.company("Acme")
    def test_days_sorted(self): self.l.add(self.c, "B", 1); self.assertEqual(self.l.days(), [1, 3])
    def test_median_odd(self): self.assertEqual(median([3, 1, 2]), 2)
    def test_median_even(self): self.assertEqual(median([1, 2, 3, 4]), 2.5)
    def test_median_empty(self):
        with self.assertRaises(ValueError): median([])

# 28 generated tests: every forward step between stages, and counts per stage.
for i, s in enumerate(STAGES):
    def fwd(self, s=s):
        self.l.advance(self.a, s); self.assertEqual(self.l.stage(self.a), s)
    setattr(T, f"test_forward_to_{s}", fwd)
    def cnt(self, s=s):
        self.l.advance(self.a, s); self.assertEqual(self.l.count(s), 1)
    setattr(T, f"test_count_{s}", cnt)
for n in range(16):
    def many(self, n=n):
        for k in range(n): self.l.add(self.c, f"r{k}", k)
        self.assertEqual(self.l.count(), n + 1)
    setattr(T, f"test_many_{n:02d}", many)

if __name__ == "__main__":
    unittest.main()
