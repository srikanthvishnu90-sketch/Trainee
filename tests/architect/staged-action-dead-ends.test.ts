// ACTION-SHAPED DEAD ENDS (2026-11-01): a message that tells Trainee to apply, submit, send, withdraw or delete stays on code's
// path even when nothing claims it (a dead end), never the brain's; a question about an action still goes to the brain. The
// real staged decision over the in-flight world (evals/career/world.ts), where the code turns before the router are not run,
// so these reach the router's dead end. No model, no spend.
import assertNode from "node:assert/strict";
import { openWorld, USER } from "../../evals/career/world.ts";
import { actionShaped, stagedDecision } from "../../supabase/functions/agent-chat/career_staged.ts";

const W = JSON.parse(Deno.readTextFileSync(new URL("../../evals/career/worlds/in-flight.json", import.meta.url)));
const env = { get: (k: string) => ({ CAREER_BRAIN: "staged" } as Record<string, string>)[k] };
async function decide(message: string) {
  const w = await openWorld(W);
  const ctx: any = w.H.createTurnCtx({ userId: USER, threadId: "A", now: w.now, accountPersistence: true, snapshot: w.th("A").snapshot, account: w.account, postings: w.kb });
  return stagedDecision({ env, message, ctx, host: w.H, structured: false });
}

Deno.test("action-shaped dead ends stay on code's path", async () => {
  for (const m of ["apply to brex", "send the jordan email", "submit figma", "can you send emails to 100 recruiters for me", "please withdraw my stripe application"]) {
    const d = await decide(m);
    assertNode.deepEqual([d.brain, d.reason], [false, "action_dead_end"], `${m}: ${d.reason} (${d.intent})`);
  }
});

Deno.test("questions, including questions about an action, still go to the brain", async () => {
  for (const m of ["any tips for a behavioral interview?", "should i send the jordan email?", "can you tell me how to apply", "whats wrong with my resume"]) {
    const d = await decide(m);
    assertNode.equal(d.brain, true, `${m}: ${d.reason} (${d.intent})`);
  }
});

Deno.test("actionShaped reads the instruction, not a word inside a question", () => {
  for (const m of ["Apply to Stripe", "ok send it", "yes, submit the figma one", "just queue brex", "delete my data", "could you please email the recruiter at plaid", "go ahead and approve it", "retry the ramp application"])
    assertNode.equal(actionShaped(m), true, m);
  for (const m of ["how do i apply?", "should i send a thank you note?", "what happens when you submit?", "can you tell me why ramp failed", "my email is down", "applying feels hopeless"])
    assertNode.equal(actionShaped(m), false, m);
});
