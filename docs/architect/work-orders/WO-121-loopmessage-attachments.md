# WO-121: read a resume sent as a file on iMessage (LoopMessage attachment download)

## Why
Release item 14 (channel parity). `tests/architect/channel-parity-acceptance.test.ts` runs the same 20 scripts on
Telegram and iMessage and gets 19/20 the same. The one that differs is `attachment-resume`. On Telegram a PDF or
.docx resume is downloaded (getFile) and read as the person's upload (`_shared/channel_resume_upload.ts`). On iMessage
the LoopMessage adapter sees an attachment-only message and answers `FILE_NOT_READ_REPLY` ("I can't open files sent
here yet ... paste your resume as text"). It never says it read the file (PR #684). The coordinator ruled on 2026-11-10
that this is a known gap for this release and that this order wires it.

## What
- `_shared/loopmessage_adapter.ts`: an inbound message with `attachments` becomes the core's file message, with the
  attachment's URL, name and type, so `channel_inbound.ts` calls `resumeFile` as it does for Telegram.
- A LoopMessage `fetchFile`. It downloads only from LoopMessage's own attachment host (an allow list, exact hosts, https
  only), with no redirects to another host, at most 10 MB, and goes through the same `fileKind` and reader as Telegram.
  Any other host is refused, and the person is told what to send instead.
- `trainee-inbound/index.ts` passes the service client, as `trainee-telegram` does, so the upload is recorded.

## Interfaces and facts the owner confirms first (not verified; LoopMessage's documentation did not load from the build environment)
- The inbound field that carries attachments, and its shape: URLs, or objects with a URL, name and MIME type.
- The host or hosts the attachment URLs are served from, and whether they need the API key.

## Acceptance tests (written first, in `tests/architect/pending/`)
- A fixture: an attachment-only LoopMessage inbound whose URL serves `hexResumePdf("simple")` from the allowed host
  through the fake. It is read as the person's resume, and nothing is confirmed without their yes.
- A URL on another host, an http URL, a redirect off the host, and a file over 10 MB each download nothing and are told.
- `channel-parity-acceptance.test.ts`: `attachment-resume` matches Telegram and its `PARITY_GAP` entry is removed. The
  list only shrinks.

## Demo
Run the parity suite and see `parity=20/20`. Then, once the owner gives a test number, send a PDF resume by iMessage to
the live bot and check that Trainee asks to confirm its entries.

## Out of scope
WhatsApp (off at release, D-019). Photos and voice notes. Telegram's path.

## Size cap
About 250 changed lines.
