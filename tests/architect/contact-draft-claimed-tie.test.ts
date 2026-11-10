// Loop 05 (release item 5) defect: a cold-email draft or follow-up that claims a meeting, referral or relationship passed
// every check and was sent ("great meeting you at the ... meetup", "as your former colleague"). No confirmed fact ever holds
// such a tie (D-007), so it never reaches a card. The full 20-journey loop is tests/architect/pending/loop-05-outreach.test.ts.
import assertNode from "node:assert/strict";
import { CLAIMED_TIE } from "../../supabase/functions/_shared/career_contact_draft.ts";
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
