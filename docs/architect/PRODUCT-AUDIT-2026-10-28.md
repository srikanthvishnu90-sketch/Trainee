# Product audit: a brand-new person's first conversation (2026-10-28)

## How this was run
- **Driver:** 61 messy new-person messages in 3 conversations: SMS newbie, Telegram with a resume, and web messy.
- **Code under test:** the production career router bundle and host (`router_core.career.js` + `career_host.js`), which is what agent-chat runs. The snapshot was carried turn to turn. The agent brain is not released (`AGENT_BRAIN_RELEASED = false`), so the router answers every text in production.
- **Not run here:**
  - The full agent-chat handler on Postgres (`tests/flow/handler.ts`), and the Instinct harness from PR #227. Both need supabase-js from npm, and Instinct also needs Playwright. The sandbox's egress proxy refuses `registry.npmjs.org` and `esm.sh` with a 403.
  - Because of that, the code-first modules that run before the router are not covered here. These are the status, apply-queue and cards modules, which may claim some status and apply texts in production.
- **Script:** the driver lives outside the repo (scratchpad). Its focused regression test is `tests/career-new-user-replies-20261028.test.cjs`.

Ranked by how many first conversations each one hurts.

| # | Message(s) | Reply today | Why it is bad | Fix |
|---|---|---|---|---|
| 1 | "thx", "lol ok", "yes", "no", "idk", "nvm", "jobs", "apply", "upload resume", "i dont have a resume", "how much does this cost", "cancel", "that was wrong", "whats my status", "did i get any replies", "networking", "my name is jordan" (20 of 61) | "I did not catch what to do with that one. Here is what I can do: find and screen roles …; draft outreach and negotiation messages, always held for your approval. Which role or company is it about, and what date does it turn on?" (405 chars) | A "didn't catch that" dead end with a capability dump. It asks about "what date" for a "thx". It is two SMS texts long and ignores state. | **Fixed (PR 1).** The catch-all answers by message kind and asks one question. It checks whether a resume is on record. Every reply fits in one text. |
| 2 | "hi", "what can you do", "who are you", "hey whats up" | 477-char greeting with "What you tell me about your search stays on your record …" | Too long for a text (2 SMS). It reads like a policy, and it is the same whatever the person has done. | **Fixed (PR 1).** The greeting is one text, and its next step fits the record. "yo" and "wat can u do" now reach it. |
| 3 | "thx" | Catch-all default | The typo corrector rewrote "thx" as "the". Texting shorthand (thx, ty, idk, nvm, lol, pls, wat …) was being "corrected". | **Fixed (PR 1).** Shorthand is never corrected. |
| 4 | "data analyst jobs in chicago" | Catch-all | A plain role search typed in lowercase was not seen as a search. Only "in Chicago" with a capital letter matched. | **Fixed (PR 1).** "<role> jobs in <city>" in lowercase is a search. |
| 5 | "find me jobs" | "…closest fit on your profile, with the gaps named in the caveat; caveat: the role is in Remote, outside the places on your profile, so it means relocating." | Wrong against state: there are no places on the profile, and a remote role does not mean relocating. Robotic, with a raw link inside a sentence. | **Fixed (PR 2).** A "Remote" location is remote. There is no location caveat when the profile names no place, no "caveat: no tradeoff stated", and no "ranked by your profile" when no profile exists. The next step asks for the resume. |
| 6 | "can u help me get a job", "i need a job asap" | "For Summer 2027, these are the internship and new-grad roles … searched with no profile on file yet, so nothing about you is assumed." | Wrong against state: nobody said internship or Summer 2027. Internal boilerplate. | **Fixed (PR 2).** Only an ask that mentions internships, new-grad roles or a summer gets the internship band. |
| 7 | "how do i upload my resume" | "Send the file and the run for every name on it is fixed. Each address gets verified … enrichment is the step that costs money" | Wrong feature: it answers with the networking contact-list upload. | **Fixed (PR 2).** A resume question gets the resume answer. A contact list still goes to its own intake. |
| 8 | "what do you know about me" (after confirming a 15-fact resume) | "Nothing is on your record yet." | Wrong against state, and it destroys trust. | **Fixed (PR 2).** Recall reads the confirmed resume entries, counted by kind. "remind me tomorrow to …" is no longer read as a recall. |
| 9 | Paste resume | 1,586-char reply with every fact run together in one paragraph | Far over 3 texts on SMS, and unreadable. | Next: show a short summary ("15 entries: 1 school, 2 jobs, 2 projects, 9 skills") plus the entries as a list, or split them by channel. The reply-writer PR's channel-native splitting covers the delivery side. |
| 10 | "stop", then "help" | "Career work is paused. … Earlier uncertain actions remain recorded and will not be retried automatically." | Internal jargon. On SMS, "STOP" and "HELP" are carrier keywords, so this surprises people. | **Fixed (PR 2).** Plain words, plus the exact phrase that resumes work. |

Also seen (below the top 10):

- **"send an email to the recruiter at acme":** it returned the stopped apply batch. The reply says "a chat yes never submits", which contradicts D-MS-1.
- **"reach out to people at stripe":** 652 chars. It contains "planned, not enforced today" and daily caps, which contradict NO LIMITS.
- **"remind me tomorrow to follow up":** this recited the record instead of setting a reminder.
- **Goal record:** the reply carries the boilerplate "These facts are what your searches … nothing about you is assumed".
- **Tracker reply:** it includes "a stage is spoken only from the record".
- **Correction:** "actually my email is …" fell back to the host's generic line.
