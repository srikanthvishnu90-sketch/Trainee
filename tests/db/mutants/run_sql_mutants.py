#!/usr/bin/env python3
# Mutation check for a migration and its SQL test (strict standard: every guard has a mutant its test turns red).
#   python3 tests/db/mutants/run_sql_mutants.py <mutants.py> [name-prefix ...]
# A mutants file defines MIGRATION (repo path), TEST (repo path), SETUP (repo paths run once before the test, in order)
# and M = [(name, old, new)]: old must occur exactly once in the migration (None appends new). For each mutant the
# migration is re-applied mutated, the test run, then the migration re-applied as written. A database is provisioned
# by tests/flow/provision-pg.sh (with the card-cloud bridge) on a free local port, as the CI database job builds it.
# Exit 0 only when the control is green, every mutant applied, every mutant turned the test red, and the restored
# control is green again.
import os, re, subprocess, sys, tempfile, runpy, socket
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
spec = runpy.run_path(sys.argv[1])
only = sys.argv[2:]
MIG = open(os.path.join(ROOT, spec['MIGRATION'])).read()
TEST = os.path.join(ROOT, spec['TEST'])
W = tempfile.mkdtemp(prefix='sqlmut-')
s = socket.socket(); s.bind(('127.0.0.1', 0)); PORT = str(s.getsockname()[1]); s.close()
r = subprocess.run(['bash', os.path.join(ROOT, 'tests/flow/provision-pg.sh'), W, PORT], env=dict(os.environ, INCLUDE_BRIDGE='1'), capture_output=True, text=True)
if r.returncode: print(r.stdout[-1500:], r.stderr[-1500:]); sys.exit(2)
P = ['psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', W, '-p', PORT, '-U', 'postgres', '-d', 'postgres']
def sql(f): return subprocess.run(P + ['-f', f], capture_output=True, text=True)
def apply(text):
    f = os.path.join(W, 'm.sql'); open(f, 'w').write(text); return sql(f)
def first_error(out): return next((l for l in out.splitlines() if 'ERROR' in l), '')[:220]
try:
    for f in spec.get('SETUP', []):
        x = sql(os.path.join(ROOT, f))
        if x.returncode: print('SETUP FAILED', f, x.stderr[-400:]); sys.exit(2)
    a = apply(MIG)
    if a.returncode: print('MIGRATION FAILED', a.stderr[-600:]); sys.exit(2)
    base = sql(TEST)
    print('CONTROL', 'GREEN' if base.returncode == 0 else 'RED ' + first_error(base.stdout + base.stderr))
    if base.returncode: sys.exit(1)
    red, bad = 0, []
    M = [m for m in spec['M'] if not only or any(m[0].startswith(o) for o in only)]
    for name, old, new in M:
        if old is None: text = MIG + new
        else:
            n = MIG.count(old)
            if n != 1: print(f'ANCHOR {name}: found {n} times'); bad.append(name); continue
            text = MIG.replace(old, new)
        a = apply(text)
        if a.returncode: print(f'NOT APPLIED {name}: {first_error(a.stderr)}'); bad.append(name); apply(MIG); continue
        t = sql(TEST)
        if t.returncode != 0: red += 1; print(f'RED      {name}: {first_error(t.stdout + t.stderr)}')
        else: print(f'SURVIVED {name}'); bad.append(name)
        apply(MIG)
    fin = sql(TEST)
    print('RESTORED', 'GREEN' if fin.returncode == 0 else 'RED ' + first_error(fin.stdout + fin.stderr))
    print(f'{red}/{len(M)} red' + (f'; not red: {", ".join(bad)}' if bad else ''))
    sys.exit(0 if red == len(M) and fin.returncode == 0 else 1)
finally:
    subprocess.run([os.path.join(os.environ.get('PGBIN', '/usr/lib/postgresql/16/bin'), 'pg_ctl'), '-D', os.path.join(W, 'data'), '-m', 'immediate', 'stop'], capture_output=True)
