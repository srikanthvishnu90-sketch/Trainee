# Product

## Register

product

## Users

Anybody looking for work (D-004): students and new graduates, career changers, and experienced candidates. They start
in a text conversation (Telegram, WhatsApp, iMessage/SMS) or on the web, and want applications sent, outreach done and
status known without doing the repetitive work themselves.

## Product Purpose

Trainee is a personal career agent. It learns the person from facts they confirm, finds matching openings, prepares
truthful tailored applications and networking emails, and carries each one out only after the person approves the
exact payload. It tracks replies and outcomes, and tells the person plainly where they stand. Success is measured in
interviews and offers, not message counts (`docs/architect/ARCHITECTURE.md` section 2). Capability scope lives in the
specs under `docs/architect/specs/` (mass applying, networking, task intelligence) and the owner rulings in
`docs/architect/DECISIONS.md`; a feature is claimed only when the code and a passing test exist.

## Brand Personality

Direct, warm and plain. Say what was done, what is waiting for a yes, and what is unknown. Brand primary is plum
`#5C2751` (D-DESIGN-1), used for the primary action and selected states, with contrast held at WCAG AA or better in
light and dark.

## Anti-references

- Inventing a fact about the person, or an answer to an application question (D-007).
- Saying something was submitted, sent or confirmed without the employer's or provider's own record (D-024).
- Spam-style volume: copy-paste applications, emails to bounced or opted-out addresses, duplicates to one posting.
- Automating LinkedIn or Indeed, solving captchas, or asking for a password or one-time code in chat.
- Canned reply prose written to pass a test; the brain is a model calling tools.

## Design Principles

- The model decides, code enforces: external effects (submit, send, message) need the person's approval of the exact
  payload, bound to its hash. One reply can approve exactly the batch shown, and nothing more.
- Facts about the person come only from what they confirmed; a missing fact is asked for once, not guessed.
- Every action ends with proof the person can see, or the reply says it is unconfirmed.
- Hand off what must be the person's: captchas, passwords, account sign-in, emailed codes the person must act on.
- Trainee sets no volume limit of its own (D-NO-LIMITS); it slows down only when an outside system refuses, and says so.

## Accessibility and Inclusion

New pages and forms need keyboard access, visible focus, readable contrast in light and dark, mobile layouts, and
reduced-motion support (`tests/architect/design-tokens.test.ts`, `design-pages-browser.test.ts`). No accessibility
certification is claimed.
