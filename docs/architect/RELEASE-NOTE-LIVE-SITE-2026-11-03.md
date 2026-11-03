# Release note: live-site fixes (2026-11-03)

What was found on the live site and what the repo now does. Nothing here was applied to Vercel or Supabase; the steps for the owner are at the end.

## Findings

- **/file and /connect are not Vercel 404s.** On the production deployment (release/production, dpl_Dep28fNj) the root `vercel.json` rewrites and the root `api/` functions both deploy. `/connect` runs `api/connect.js` and answers 503 "not set up" because `TRAINEE_CONNECT_UPSTREAM` is unset. `/file` runs `api/file.js`; `TRAINEE_FILE_UPSTREAM` is set, but the edge function it points at is not deployed (the Supabase project `mrwngntwmnaqrqhupvlt` lists no `trainee-file` and no `trainee-connect`), so Supabase answered `{"code":"NOT_FOUND","message":"Requested function was not found"}` and the proxy passed it through as a 404.
- **/privacy** is the browser-extension policy (the page `main` served since Oct 20). Trainee has no chat-service privacy policy yet: it needs `LEGAL_NAME`, `SUPPORT_EMAIL`, `GOVERNING_STATE` (`docs/launch/legal-pages/owner-inputs.json`), which are unset.
- The homepage source (`site/index.html` on trunk) was the unbuilt template: `[YOUR PRICE]`, `[DATE]`, founder placeholders, `careers@example.com`, the Twilio sandbox WhatsApp link, an unclipped-select CSS bug.

## What changed in the repo

- `api/file.js`, `api/connect.js`: an upstream function that is not deployed now gives an honest 503 "not available yet" instead of a bare 404.
- The homepage template moved to `docs/launch/legal-pages/home.template.html` (so nothing with a placeholder sits in `site/`, as for the privacy and terms templates). `site/index.html` is its interim build: `deno run -A scripts/launch/build-legal-pages.ts --interim`. The full build (with owner inputs) reads the same template and overwrites `site/index.html`, `privacy.html`, `terms.html`, `google.html`.
- Interim homepage: no Privacy/Terms/Gmail-notice links, no support or careers address, no WhatsApp button, no price, launch-timing, story or founder placeholders. The waitlist consent keeps its SMS Terms link only.
- `site/privacy.html` is retitled and labelled as the extension policy, with a notice that the chat service has no published policy yet.
- Country selector column widened (150px to 240px) so "United States +1" is not clipped.

## Owner decisions and inputs

1. Fill `LEGAL_NAME`, `SUPPORT_EMAIL`, `GOVERNING_STATE`, then run the full build; this restores /privacy (Trainee), /terms, /google and the support and careers addresses. Until then the waitlist's SMS consent has no linked Privacy Policy or Terms (SMS Terms only): consider pausing the waitlist if that is not acceptable.
2. WhatsApp: add a button back only with Trainee's own number, not the Twilio sandbox.
3. Price, launch timing, founder story and bio: supply real text or leave them out.
4. The extension policy text is not edited; PR #440 lists where it no longer matches extension 0.2.0. Needs your review.

## Needed for /file and /connect to work (facts only, not decided here)

- Supabase: the `trainee-file` and `trainee-connect` edge functions are not deployed.
- Vercel env vars the proxies read: `TRAINEE_FILE_UPSTREAM` and `TRAINEE_CONNECT_UPSTREAM` (the functions' `/functions/v1/<name>` URLs).
- Until both are in place `/file` and `/connect` answer 503.

Vercel Output Directory and production routes: Instinct decides at release time; not touched here.
