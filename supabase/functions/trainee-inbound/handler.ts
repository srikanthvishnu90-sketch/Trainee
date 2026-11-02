// Texts coming in over iMessage (WO-013b-2), as a function of its inputs so it is testable without a database, a provider
// or a model. LoopMessage posts every inbound text here. Since WO-038 the order and the rules live in the channel-neutral
// core (_shared/channel_inbound.ts runInbound) that WhatsApp and Telegram share; LoopMessage is one adapter
// (_shared/loopmessage_adapter.ts) and this handler keeps its inputs, outputs and tests exactly as they were: the secret,
// then the message id claimed (a retried webhook never runs a second turn), then STOP/START/HELP (answered and recorded
// before any account exists), then who may sign up (the owner's call; closed by default), then the turn through
// agent-chat as that person, whose reply goes out through the outbox so the daily contact cap and the at-most-once rule
// cover it.
import { equalSecret } from "../_shared/message_service.ts";
import type { Send } from "../_shared/channel.ts";
import { loopMessageAdapter } from "../_shared/loopmessage_adapter.ts";
import { textingNativeOn } from "../_shared/channel_voice.ts";
import { runInbound, type InboundStore } from "../_shared/channel_inbound.ts";

export { CHAT_DOWN_REPLY, SIGNUP_CLOSED_REPLY, signupAllows, turnKeyFor } from "../_shared/channel_inbound.ts";
export type { InboundStore, Person } from "../_shared/channel_inbound.ts";
export interface InboundDeps {
  env: { get(k: string): string | undefined };
  now: () => number;
  store: () => InboundStore;
  send: (apiKey: string) => Send; // channel commands and the signup refusal go straight out: no account, no outbox row
  chat: (a: { userId: string; threadId: string | null; message: string; turnKey: string }) => Promise<{ status: number; reply: string; threadId: string | null }>;
  deliverReply: (a: { userId: string; key: string; apiKey: string; now: number }) => Promise<unknown>;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function handleInbound(req: Request, d: InboundDeps): Promise<Response> {
  // The door, as WO-013b-2 shipped it (the adapter's parse checks the same again).
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = d.env.get("TRAINEE_INBOUND_SECRET") || "";
  if (secret.length < 32) return json({ error: "not configured: TRAINEE_INBOUND_SECRET must be set, 32 characters or more" }, 503);
  const got = new URL(req.url).searchParams.get("secret") || req.headers.get("x-trainee-secret") || "";
  if (!equalSecret(got, secret)) return json({ error: "forbidden" }, 403);
  const apiKey = d.env.get("LOOPMESSAGE_API_KEY") || "";
  if (!apiKey) return json({ error: "NOT_WIRED: LOOPMESSAGE_API_KEY is not set; no turn was run" }, 503);
  const adapter = loopMessageAdapter({ apiKey, inboundSecret: secret, send: async (c, b) => await d.send(apiKey)(c, b), native: textingNativeOn(d.env) });
  const parsed = await adapter.parseInbound(req);
  if ("response" in parsed) return parsed.response;
  const msg = parsed.messages[0];
  // CHANNEL DELIVERY ROUND 2 (2026-10-30): LoopMessage's message_failed / message_timeout for a message Trainee sent: its
  // row is marked failed with the reason (it stayed "delivered"). A callback delivered twice changes nothing the second time.
  if (!msg && parsed.statuses?.length) {
    const store = d.store();
    let failed = 0;
    for (const st of parsed.statuses) if (store.failSent) failed += await store.failSent(st.providerMessageId, d.now(), st.error, false);
    return json({ ok: true, failed });
  }
  if (!msg) return json({ ok: true, ignored: (parsed.ignored ?? [])[0] ?? "nothing to read" });
  const send = d.send(apiKey);
  const r = await runInbound(msg, {
    env: d.env, now: d.now, store: d.store(), render: adapter.render, chat: d.chat,
    reply: (contact, bubbles) => send(contact, bubbles),
    deliver: (a) => d.deliverReply({ userId: a.userId, key: a.key, apiKey, now: a.now }),
  });
  return json(r.body, r.status);
}
