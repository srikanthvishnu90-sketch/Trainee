// SC-300 / quality-spec 01 R-A4 (S0) — the kill switch must ALWAYS halt.
// "Stop everything" halts every queue for the user within one tick. It
// reports sent / in-flight-unconfirmed / halted counts that reconcile to
// the queue total. No item is left half-sent. If queue state can't be
// read, the system halts anyway by setting the global user pause flag,
// then says what it could not verify.
// Written fail-first against the pre-fix 141: with no queue state in ctx
// the old code replied "I cannot find the outreach queue state, so I
// halted nothing" and set NO pause anywhere (there was no global pause
// flag in any career module).
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const Doorstep = require(path.join(root, "packages/domain/141-career-doorstep.js"));
const Outreach = require(path.join(root, "packages/domain/124-career-outreach.js"));

const NOW = "2026-10-13T12:00:00Z";
const NO_OP = /halted nothing|stopped nothing|cannot find/i;

function assertPauseSet(r, ctx) {
  assert.equal(r.intent, "queue_halt");
  assert.equal(r.global_pause_set, true, "result carries global_pause_set:true");
  assert.ok(ctx.globalPause, "ctx.globalPause is set for the host to persist/honor");
  assert.equal(ctx.globalPause.set, true);
  assert.equal(ctx.globalPause.scope, "all-queues");
  assert.equal(ctx.globalPause.at, NOW, "pause stamp uses the turn clock");
  assert.ok(ctx.globalPause.by, "pause records who set it");
}

test("R-A4 unreadable queue (no queue state in ctx): global pause is set, reply is honest, no no-op phrases", () => {
  const ctx = { now: NOW, userId: "user-1" };
  const r = Doorstep.handleChat("stop everything", ctx);
  assert.ok(r, "the stop turn must be answered");
  assertPauseSet(r, ctx);
  assert.equal(r.resultStatus, "completed");
  assert.equal(r.counts_verified, false, "counts are explicitly UNVERIFIED when the queue cannot be read");
  assert.doesNotMatch(r.reply, NO_OP, "the old no-op wording is gone");
  // architect ruling F.3 (2026-11-09): the reply never claims an account pause it did not write; it says so and names "pause everything".
  assert.doesNotMatch(r.reply, /pause is (now )?set|(?<!not )paused your account/i, "no claim of an account pause");
  assert.match(r.reply, /pause everything/i, "names how to pause the account");
  // MI-048 triage (2026-10-15): the halt sentence was reworded ("blocks
  // every send path this product controls"); every semantic element of
  // the R-A4 contract is present — the pin follows the current wording.
  assert.match(r.reply, /blocks every send path/i, "reply states nothing can start or continue");
  assert.match(r.reply, /could not read/i, "reply states the queue's own records could not be read");
  assert.match(r.reply, /unverified/i, "reply states the exact counts are unverified");
  assert.equal((r.reply.match(/next step/gi) || []).length, 1, "reply gives exactly one next step");
});

test("R-A4 missing-file queueStatePath: same honest halt, and loadQueueState never throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ra4-missing-"));
  const ctx = { now: NOW, userId: "user-1", queueStatePath: path.join(dir, "no-such-queue.json") };
  let r = null;
  assert.doesNotThrow(() => { r = Doorstep.handleChat("stop everything", ctx); }, "a missing queue file is 'can't be read', never a crash");
  assert.ok(r, "the stop turn must be answered");
  assertPauseSet(r, ctx);
  assert.equal(r.resultStatus, "completed");
  assert.equal(r.counts_verified, false);
  assert.doesNotMatch(r.reply, NO_OP);
  assert.doesNotMatch(r.reply, /pause is (now )?set|(?<!not )paused your account/i); // architect ruling F.3 (2026-11-09)
  assert.match(r.reply, /pause everything/i);
});

test("R-A4 unreadable-file queueStatePath (invalid JSON): same honest halt, no throw", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ra4-badjson-"));
  const p = path.join(dir, "queue.json");
  fs.writeFileSync(p, "{ this is not json");
  const ctx = { now: NOW, userId: "user-1", queueStatePath: p };
  let r = null;
  assert.doesNotThrow(() => { r = Doorstep.handleChat("stop everything", ctx); });
  assert.ok(r);
  assertPauseSet(r, ctx);
  assert.equal(r.counts_verified, false);
  assert.doesNotMatch(r.reply, NO_OP);
});

test("R-A4 readable queue (2 pending, 1 sent, 1 sending): pending halted, pause set everywhere, counts reconcile, suppression preserved", () => {
  const suppression = Outreach.createSuppressionStore();
  const state = {
    outreach_queue: {
      items: [
        { queue_id: "Q1", to: "a@example.test", status: "pending" },
        { queue_id: "Q2", to: "b@example.test", status: "pending" },
        { queue_id: "Q3", to: "c@example.test", status: "sent" },
        { queue_id: "Q4", to: "d@example.test", status: "sending" },
      ],
    },
  };
  const ctx = { now: NOW, userId: "user-1", queueState: state, suppression };
  const r = Doorstep.handleChat("stop everything", ctx);
  assert.ok(r, "the stop turn must be answered");
  assertPauseSet(r, ctx);
  assert.equal(r.resultStatus, "completed");
  assert.equal(r.counts_verified, true, "counts read from the queue are verified");

  const byId = Object.fromEntries(state.outreach_queue.items.map((i) => [i.queue_id, i.status]));
  assert.deepEqual(byId, { Q1: "halted", Q2: "halted", Q3: "sent", Q4: "sending" },
    "pending items halt; a sent item stays sent (DD-10 honesty); an in-flight item is left as sending, never half-sent or silently halted");
  assert.equal(state.outreach_queue.halted, true, "q.halted is set");
  assert.ok(state.global_pause && state.global_pause.set === true, "state.global_pause is set on the queue-state object");
  assert.ok(state.outreach_queue.global_pause && state.outreach_queue.global_pause.set === true, "q.global_pause is set");

  // Counts reconcile: sent + in-flight-unconfirmed + halted + already-stopped = total.
  assert.equal(r.sent_count, 1);
  assert.equal(r.in_flight_count, 1, "the 'sending' item is reported as in-flight-unconfirmed");
  assert.equal(r.halted_count, 2);
  assert.equal(r.already_stopped_count, 0);
  assert.equal(r.queue_total, 4);
  assert.equal(r.sent_count + r.in_flight_count + r.halted_count + r.already_stopped_count, r.queue_total, "counts reconcile to the queue total");
  assert.match(r.reply, /1 item had already gone out/, "the sent count is spoken (MI-048: reworded from '1 already sent')");
  assert.match(r.reply, /1 in flight and unconfirmed/);
  assert.match(r.reply, /2 halted/);
  assert.match(r.reply, /4 in total/);
  assert.doesNotMatch(r.reply, NO_OP);

  // Suppression side-effect preserved (124's own store, belt-and-braces):
  // both halted recipients are suppressed so a send-time check stops them too.
  assert.equal(r.suppressed_recipients, 2);
  assert.equal(suppression.isSuppressed({ email: "a@example.test" }, "user-1"), true);
  assert.equal(suppression.isSuppressed({ email: "b@example.test" }, "user-1"), true);
});

test("R-A4 readable queue via file persists the global pause + halt to disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ra4-persist-"));
  const p = path.join(dir, "queue.json");
  const setup = { outreach_queue: { items: [{ queue_id: "Q1", to: "a@example.test", status: "pending" }] } };
  fs.writeFileSync(p, JSON.stringify(setup, null, 2) + "\n");
  const ctx = { now: NOW, userId: "user-1", queueStatePath: p };
  const r = Doorstep.handleChat("stop everything", ctx);
  assert.equal(r.resultStatus, "completed");
  const after = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(after.outreach_queue.halted, true);
  assert.equal(after.outreach_queue.items[0].status, "halted");
  assert.ok(after.global_pause && after.global_pause.set === true, "the global pause is persisted with the queue state");
});

test("R-A4 seam in 124: sendPending/enqueue honor a global pause with a typed refusal and no send", async () => {
  const campaign = Outreach.createCampaign({ approved: true });
  campaign.global_pause = { set: true, at: NOW, by: "user", scope: "all-queues" };
  const cand = { person_id: "p1", full_name: "Pat Test", current_firm: "TEST Firm", work_email: "pat@example.test", email_verification: "verified" };
  const enq = Outreach.enqueue(campaign, [{ candidate: cand, draft: { subject: "s", body: "b" } }], {});
  assert.equal(campaign.items.length, 0, "nothing is queued while the global pause is set");
  assert.equal(enq.length, 1);
  assert.equal(enq[0].status, "rejected");
  assert.match(String(enq[0].reason), /global_pause/);

  let sends = 0;
  const transport = { send: async () => { sends++; return { messageId: "m1" }; } };
  const camp2 = Outreach.createCampaign({ approved: true });
  camp2.items.push({ id: "i1", person_id: "p1", email: "pat@example.test", status: "queued", idempotencyKey: "k1", draft: { subject: "s", body: "b" }, candidate: cand });
  const refused = await Outreach.sendPending(camp2, { transport, globalPause: { set: true, at: NOW, by: "user", scope: "all-queues" } });
  assert.equal(refused.sent, 0);
  assert.equal(sends, 0, "transport is never called while paused");
  assert.match(String(refused.error || refused.reason || ""), /global_pause/);

  // Sanity leg RE-POINTED 2026-10-14 (audit §9 item 5): without a
  // pause, the same campaign shape now refuses SEND_DISABLED at the
  // sink (owner ruling 2026-10-13: email is drafts-only, hard off) —
  // the transport is still never called; the refusal names the
  // ruling instead of the pause.
  const ok = await Outreach.sendPending(camp2, { transport });
  assert.equal(ok.sent, 0);
  assert.equal(ok.refused, true);
  assert.match(String(ok.error || ""), /SEND_DISABLED/);
  assert.equal(sends, 0);
});
