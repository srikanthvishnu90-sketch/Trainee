# Receipt pictures out of Postgres: the plan (launch readiness X4 / M10, 2026-10-26)

Not done in the launch-readiness PR. This is the plan, and why it was not done there.

## Today (read from the code on trunk)

- **Receipt pictures.** `career_apply_receipt_files.bytes_b64` holds the before-click and after-submit PNGs, and the page
  text, as base64 text in Postgres.
  - Each picture can be up to 8,388,608 base64 characters (`20261026140000_career_apply_receipt_store.sql:57`).
  - They are written by `career_apply_receipt_attach(_own)` under the drive's lease (`:76-101`), from
    `workers/career-browser/approve-first.ts`.
  - Only the bound proof's pictures are kept (`:177-181`), each until `keep_until`, the receipt's `pictures_keep_until`.
    `tests/db/career_apply_receipt_store.test.sql` checks that this is more than 89 days out.
  - `career_apply_receipt_files_expire()` deletes the expired ones (`:200-206`), but nothing schedules it: deleting is the
    owner's call (G6).
- **Channel files.** `channel_artifacts.bytes_b64` holds the files a turn sends through a channel (the tailored resume
  PDF, the receipt pictures), each with `expires_at`.
- **Erase.** Both tables are now emptied for the person by "forget everything" (`career_erase_person`,
  `20261026230100`) and by account deletion. Storage objects are not reached by either: only the `career-resumes` bucket
  is purged by `delete-account`.

## Why it was not moved in the launch-readiness PR

Moving the bytes changes three writers and two readers that other work is changing today:
- the worker's attach call (`approve-first.ts`, the cloud runner);
- the attach RPC's checks (the PNG signature and the hash, which are done in SQL on the bytes);
- the receipt reader and the channel artifact path.

It also needs a bucket created on the live project, which is a live change this work may not make.

## The change

1. **A private bucket per kind.** Create `career-receipts` and `channel-files`, with no public access. The object path is
   `<user_id>/<application_id>/<kind>-<sha256>.png`, and `<user_id>/<thread_id>/<sha256>-<filename>` for channel files.
2. **The worker uploads; the database records.** Under the lease, the worker uploads to Storage with a signed upload URL
   that a new RPC issues, `career_apply_receipt_upload_url(id, lease, kind, sha256)`: one path, one size limit, a short
   expiry. `career_apply_receipt_attach` then takes `(id, lease, kind, sha256, object_path)` instead of the bytes. It
   checks that the object exists with that size and hash (a Storage webhook or an edge function that reads the object
   once), and stores the path. `bytes_b64` becomes nullable, then is dropped once no row holds it.
3. **Short retention, scheduled.**
   - Unbound pictures (no bound proof) are deleted at the finish, as today.
   - Bound pictures keep the receipt's period, which the owner sets. The default today is about 90 days; for launch a
     shorter one, 30 days, is proposed for the owner's decision.
   - A daily scheduled run calls the expire function and deletes the Storage objects with it. Channel files go after
     `expires_at`.
4. **Erase and account deletion reach Storage.**
   - `career_erase_person` records the paths it deletes in a queue table.
   - `delete-account` lists and removes `career-receipts/<uid>/` and `channel-files/<uid>/`, as it already does for
     `career-resumes`.
   - A test lists every bucket the product writes and fails on one that neither erase reaches.
5. **Proof that it holds.**
   - A DB test: no row of either table holds bytes.
   - A flow test (`tests/architect/flow-receipt.test.ts`'s path) in which the picture is read back from Storage by hash.
   - An erase test that the objects are gone.

## Owner decisions needed

- The retention period for bound receipt pictures (today about 90 days; 30 days proposed).
- Creating the two buckets on the live project, and scheduling the expiry run.
