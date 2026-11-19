// Word-vomit benchmark (evals/word-vomit WV27): words for the person to send themselves on LinkedIn are a draft, not an act on
// LinkedIn. Before: "can u draft a linkedin msg but i dont have his last name" got the LinkedIn refusal and no draft. Every act
// handed to Trainee on LinkedIn is still refused (tests/architect/f10-outreach-v2.test.ts L).
import assertNode from "node:assert/strict";
import { siteAsk } from "../../supabase/functions/_shared/career_outreach_track.ts";

Deno.test("word-vomit: a LinkedIn message to paste yourself is a draft; handing the act over is still refused", () => {
  for (const m of ["i met a guy at the career fair from harborlight, marcus something, he said to reach out. can u draft a linkedin msg but i dont have his last name",
    "help me word a linkedin note to my old manager", "write me a linkedin connection request for a recruiter at stripe"]) assertNode.equal(siteAsk(m), null, m);
  for (const m of ["draft a linkedin msg and send it to marcus for me", "write a linkedin message and dm him", "message maya on linkedin", "write to maya via LinkedIn about coffee"]) assertNode.equal(siteAsk(m), "LinkedIn", m);
});
