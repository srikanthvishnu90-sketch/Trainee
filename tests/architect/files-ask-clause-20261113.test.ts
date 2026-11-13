// Review of PR #803 (D-072 follow-up): the opt-out and write-new words were read anywhere in the message, so ordinary asks to see a
// File stopped being File asks. familyAskOf now reads them from the clause that GOVERNS the File's name. $0: no model, no network.
//   FC-1  THE TEN REGRESSIONS: each was a File ask before #803 and is again.
//   FC-2  A SEE-ASK WITH A CONTROL-LOOKING OR WRITE-LOOKING WORD ELSEWHERE is still a see-ask.
//   FC-3  AN OPT-OUT WORDED WITH A SEE-VERB ELSEWHERE is still an opt-out (null), and so is a new thing to make.
//   FC-4  "MAKE ME MY WEEKLY BRIEF": the person's own always-drawn File (F-01, F-02, F-14) is opened; a plan or "a ... for X" is not.
//   FC-5  GENUINELY MIXED messages are null (the older routes).
//   deno test -A --no-check tests/architect/files-ask-clause-20261113.test.ts
import assertNode from "node:assert/strict";
import { familyAskOf } from "../../supabase/functions/_shared/file_family_ask.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const each = (rows: [string, string | null][]) => { for (const [m, f] of rows) eq(familyAskOf(m), f, m); };

Deno.test("FC-1 THE TEN REGRESSIONS of #803 are File asks again", () => each([
  ["Where's my weekly brief? I can't find the link", "F-14"],
  ["can't open my career brief, send me the link", "F-01"],
  ["send me the weekly brief link, the old one doesn't work", "F-14"],
  ["show me my weekly brief by end of day", "F-14"],
  ["show me my offers page, don't summarize", "F-15"],
  ["show me my negotiation plan again, the link won't load", "F-14n"],
  ["show me my interview hub so I can prepare", "F-13"],
  ["show me my career brief before I make a decision", "F-01"],
  ["show me my search plan so I can start applying", "F-04"],
  ["show me my materials page for the design role", "F-07"],
]));

Deno.test("FC-2 A SEE-ASK with a negation, a control word or a write verb that does not govern the File's name is a see-ask", () => each([
  ["don't forget to send me my weekly brief", "F-14"],
  ["I didn't get my weekly brief, send it again", "F-14"],
  ["I can't find my interview hub", "F-13"],
  ["make sure to send me my weekly brief", "F-14"],
  ["show me my career brief, not the weekly one", "F-01"],
  ["send me my weekly brief so I can plan my week", "F-14"],
  ["open my interview hub, I need to practice", "F-13"],
  ["show me my resume versions", "F-07"],
  ["I stopped by to see my offer comparison", "F-15"],
  ["pull up my answer library before I start the next application", "F-08"],
  ["show me my interviews page so I can prepare", "F-13"],
  ["my search plan link doesn't open", "F-04"],
  ["show me my weekly brief, don't summarize it", "F-14"],
]));

Deno.test("FC-3 AN OPT-OUT worded with a see-verb elsewhere stays an opt-out, and a new thing to make stays the planning turn's", () => each([
  ["stop sending the weekly brief, I'll open it myself", null],
  ["don't show me the weekly brief again", null],
  ["I don't want the weekly brief anymore, where do I turn it off", null],
  ["the weekly brief is too much, stop sending it", null],
  ["show me how to turn off the weekly brief", null],
  ["send me the link to unsubscribe from the weekly digest", null],
  ["I've seen my weekly brief, no more of those please", null],
  ["my weekly brief, please stop", null],
  ["the weekly brief page needs to stop", null],
  ["weekly brief emails off", null],
  ["I opened the weekly brief link and I don't want it", null],
  ["can you not send me the weekly brief", null],
  ["I can't stop getting the weekly brief, send help", null],
  ["give me a way to mute the weekly summary", null],
  ["open my settings and cancel the weekly report", null],
  ["send me my weekly brief and then stop sending it", null],
  ["resume my weekly brief", null],
  ["show me my search plan and draft a new one", null],
  ["open my career brief and write me a new version", null],
  ["help me prepare my negotiation plan", null],
  ["start a search plan for me, show me when done", null],
]));

Deno.test("FC-4 MAKE ME MY WEEKLY BRIEF opens the person's own always-drawn File; a plan, or a new one for something, is not opened", () => each([
  ["make me my weekly brief", "F-14"],
  ["build my career brief", "F-01"],
  ["make me my search plan", null],
  ["make me a weekly brief for my manager", null],
  ["make me my weekly brief for consulting", null],
]));

Deno.test("FC-5 GENUINELY MIXED messages are left to the older routes (null)", () => each([
  ["don't send me the weekly brief every week, just show it to me now", null],
  ["stop. show me my weekly brief", null],
  ["I don't see my weekly brief anywhere", null],
  ["after I change jobs show me my career brief", null],
  ["show me my weekly brief and turn it off after", null],
]));
