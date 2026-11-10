// Loop 05 (release item 5) defect: a cold-email draft or follow-up that claims a meeting, referral or relationship passed
// every check and was sent ("great meeting you at the ... meetup", "as your former colleague"). No confirmed fact ever holds
// such a tie (D-007), so it never reaches a card. The full 20-journey loop is tests/architect/pending/loop-05-outreach.test.ts.
import assertNode from "node:assert/strict";
import { checkContactDraft, CLAIMED_TIE, type ContactIn } from "../../supabase/functions/_shared/career_contact_draft.ts";
import { followupOk } from "../../supabase/functions/_shared/career_contact_send.ts";

Deno.test("claimed ties are refused in drafts and follow-ups; plain hooks are not", () => {
  for (const s of ["It was great meeting you at the payments meetup last month.", "As your former colleague, I wanted to ask.", "Robin suggested I reach out.",
    "We spoke at APIConf.", "Following up on our call.", "As discussed, here is my note.", "A mutual friend gave me your name.", "Jane referred me to you.",
    "Nice to meet you last week.", "I'd love to reconnect.", "We worked together at Acme.", "Sam introduced me to your work."]) {
    assertNode.ok(CLAIMED_TIE.test(s), s);
    assertNode.equal(followupOk(`Hi, ${s}`), false, `follow-up: ${s}`);
  }
  for (const s of ["I read that you lead the payments platform team.", "Would you share how your team approaches meeting deadlines?", "Hi, following up on my note below in case it got buried.",
    "Hi, one last note: thanks either way.", "I read the token bucket in your rate-limiter repository on GitHub.", "Your talk on team meetings at APIConf was useful."]) {
    assertNode.ok(!CLAIMED_TIE.test(s), s);
  }
});

// The six invented mails loop 05 found sent (run before the fix, both contact flags on): J05 (a meeting), J07 (a former
// colleague) and J08 (a meeting, first try), each counted once on its card and once in Gmail. Each, exactly as drafted, now
// fails checkContactDraft; the same tie fails followupOk as a follow-up. The plain version of the same draft still passes.
Deno.test("loop 05 regressions: the six invented mails are refused, the plain draft passes", () => {
  const contact = (name: string): ContactIn => ({
    person: { name, title: "Engineering Manager", company: "FirmX", domain: "firmx.example", source_url: "https://firmx.example/team" },
    facts: [{ claim: `${name} leads the payments platform team at FirmX.`, source_url: "https://firmx.example/team", source_type: "company_page", published_at: null, quote_snippet: `${name} leads the payments platform team at FirmX.`, confidence: 0.85, method: "company_page page read through robots" }],
    email: { email: `${name.toLowerCase().replace(" ", ".")}@firmx.example`, method: "first_party_published", score: 95, approvable: true, why: "published" }, expires_at: "2027-02-05T00:00:00.000Z",
  });
  const SENDER = [{ kind: "education", value: "B.S. Computer Science, TEST University", status: "confirmed" }];
  const body = (first: string, lie: string) => `Hi ${first},\n\n${lie}I read that you lead the payments platform team.\n\nWould you share how your team approaches payments platform work?`;
  const chk = (name: string, lie: string) => { const c = contact(name); return checkContactDraft({ subject: "Your payments platform team", body: body(name.split(" ")[0], lie), hook: 1 }, { facts: c.facts, senderFacts: SENDER, contact: c }); };
  const cases: [string, string, string][] = [
    ["J05 card", "Eli Moss", "It was great meeting you at the payments platform meetup last month. "],
    ["J05 sent", "Eli Moss", "It was great meeting you at the payments platform meetup last month. "],
    ["J07 card", "Gus Reyes", "As your former colleague, "],
    ["J07 sent", "Gus Reyes", "As your former colleague, "],
    ["J08 card", "Hana Sato", "It was great meeting you at the payments platform meetup last month. "],
    ["J08 sent", "Hana Sato", "It was great meeting you at the payments platform meetup last month. "],
  ];
  for (const [id, name, lie] of cases) {
    assertNode.ok(chk(name, lie).some((x) => /claimed meeting, referral or relationship/.test(x)), `${id}: refused`);
    assertNode.equal(followupOk(`Hi, ${lie.trim()} following up on my note below.`), false, `${id}: refused as a follow-up`);
    assertNode.deepEqual(chk(name, ""), [], `${id}: the same draft without the claim passes`);
  }
});
