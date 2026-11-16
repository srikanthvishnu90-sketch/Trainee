# Invented fixture for sandbox spike 2: a small job-application ledger on in-memory sqlite3.
import sqlite3
STAGES = ["saved", "applied", "screen", "interview", "offer", "closed"]

class Ledger:
    def __init__(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.execute("CREATE TABLE company (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL)")
        self.db.execute("CREATE TABLE app (id INTEGER PRIMARY KEY, company INTEGER NOT NULL REFERENCES company(id) ON DELETE CASCADE, role TEXT, stage TEXT, day INTEGER)")

    def company(self, name):
        cur = self.db.execute("INSERT INTO company(name) VALUES (?)", (name,))
        return cur.lastrowid

    def add(self, company, role, day):
        return self.db.execute("INSERT INTO app(company, role, stage, day) VALUES (?,?,?,?)", (company, role, "saved", day)).lastrowid

    def advance(self, app, stage):
        cur = self.db.execute("SELECT stage FROM app WHERE id=?", (app,)).fetchone()
        if cur is None:
            raise KeyError(app)
        if STAGES.index(stage) < STAGES.index(cur[0]):
            raise ValueError("cannot move backwards")
        self.db.execute("UPDATE app SET stage=? WHERE id=?", (stage, app))

    def stage(self, app):
        return self.db.execute("SELECT stage FROM app WHERE id=?", (app,)).fetchone()[0]

    def count(self, stage=None):
        if stage is None:
            return self.db.execute("SELECT COUNT(*) FROM app").fetchone()[0]
        return self.db.execute("SELECT COUNT(*) FROM app WHERE stage=?", (stage,)).fetchone()[0]

    def remove_company(self, company):
        self.db.execute("DELETE FROM company WHERE id=?", (company,))

    def days(self):
        return [r[0] for r in self.db.execute("SELECT day FROM app ORDER BY day")]

def median(xs):
    xs = sorted(xs)
    n = len(xs)
    if n == 0:
        raise ValueError("empty")
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2
