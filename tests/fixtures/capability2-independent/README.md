# Independent frozen capability 2 probes

The manifest and runner are exact bytes recovered from Library
`libfile_1dac91c522fc819185caf29f1d392cc7`, backed by the 40-payload review archive
`libfile_68b899fa50548191aa774c015e3579ad`. freeze-metadata.json records the
original hashes. These are synthetic review boundaries, not the unrecovered
original private 50 cases or an end-user quality score.

`node scripts/career/run-capability2-frozen.cjs --evidence-dir /tmp/c2-frozen`
runs the original assertions unchanged. Only the review machine's absolute host
path is aliased to this checkout; a temporary source/ symlink points to these
modules. Supply `--host-root /path/to/atomic-checkout` for the atomic-host seam.
The original manifest's source_sha identifies the reviewed baseline; execution.json
separately records the candidate commit and host hash actually used.

The runner exits 1 while H20 remains unresolved. Module 130's cross-owner cache
repair is assigned to Crew A. The added Node regression test marks H20 pending;
it does not turn that probe into an expected success. The full original runner
result is always retained separately with its actual failure.
