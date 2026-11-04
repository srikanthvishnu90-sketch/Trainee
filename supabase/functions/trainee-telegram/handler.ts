// Texts coming in over Telegram (WO-038), as a function of its inputs so it is testable without a database, Telegram or a
// model. Telegram posts every update here (setWebhook with secret_token: docs/launch/TRAINEE-GO-LIVE.md). The door is
// Telegram's own secret header; the rest is the same core as iMessage and WhatsApp (_shared/channel_inbound.ts).
// FEATURE 16 (2026-10-26): with the service client (`admin`), a resume sent as a PDF or .docx is downloaded and read as
// the person's upload (channel_resume_upload.ts), and a tap on a card's Approve or Decline answers the card exactly as
// the web tap does (channel_card_tap.ts). Without it, both are said plainly and nothing is read or approved.
import { addressOf, type ChannelAdapter } from "../_shared/channel_adapters.ts";
import { handleChannelWebhook, type CoreDeps, type InboundStore } from "../_shared/channel_inbound.ts";
import { telegramAdapter } from "../_shared/telegram.ts";
import { ingestResumeFile, supabaseUploadRecorder } from "../_shared/channel_resume_upload.ts";
import { supabaseTapStore, tapCard } from "../_shared/channel_card_tap.ts";
import { supabaseEventStore } from "../_shared/agent/timeline.ts";
import { fetchArtifactBytes } from "../_shared/channel_artifacts.ts";
import { type JobDeps, type JobSender, sendJobCards, supabaseConfirmedFacts, supabaseJobStore, tapJob } from "../_shared/telegram_jobs.ts";
import { feedUrlsFor } from "../_shared/file_link.ts";
import { supabaseCardStore } from "../_shared/career_apply_cards.ts";

export interface ProviderWebhookDeps {
  env: { get(k: string): string | undefined };
  now: () => number;
  store: () => InboundStore;
  chat: CoreDeps["chat"];
  deliver: CoreDeps["deliver"];
  adapter?: (env: ProviderWebhookDeps["env"]) => ChannelAdapter; // tests inject one over a fake fetch
  // deno-lint-ignore no-explicit-any
  admin?: any; // FEATURE 16: the service client, for the resume file and the card's buttons
}
// The adapter's sends, bound to one chat, as the job cards use them.
export function jobSenderFor(adapter: ChannelAdapter, address: string): JobSender {
  return {
    photo: async (a) => adapter.sendPhoto ? await adapter.sendPhoto(address, a) : { ok: false },
    text: async (a) => { const r = await adapter.send(address, [a.text], { buttons: a.buttons }); return { ok: r.ok, id: r.ok ? r.id : null }; },
    ...(adapter.editMessage ? { edit: async (a: { messageId: string; text: string; buttons?: any; caption?: boolean }) => await adapter.editMessage!(address, a.messageId, a) } : {}),
  };
}
export function webhookDeps(adapter: ChannelAdapter, d: ProviderWebhookDeps): CoreDeps {
  const admin = d.admin;
  return {
    env: d.env, now: d.now, store: d.store(), render: adapter.render, chat: d.chat, deliver: d.deliver,
    reply: async (contact, bubbles, opts) => await adapter.send(addressOf(contact), bubbles, opts),
    ...(admin && adapter.fetchFile ? {
      resumeFile: async (a: Parameters<NonNullable<CoreDeps["resumeFile"]>>[0]) =>
        await ingestResumeFile({ userId: a.userId, channel: "telegram", doc: a.doc, fetchFile: (id, max) => adapter.fetchFile!(id, max), record: supabaseUploadRecorder(admin) }),
    } : {}),
    ...(admin ? { cardTap: async (a: { userId: string; data: string; now: number }) => await tapCard({ ...a, store: supabaseTapStore(admin), events: supabaseEventStore(admin) }) } : {}),
    ...(admin ? (() => {
      const jd = (): JobDeps => ({ store: supabaseJobStore(admin), cards: supabaseCardStore(admin), tap: supabaseTapStore(admin), now: d.now, env: d.env, events: supabaseEventStore(admin),
        facts: supabaseConfirmedFacts(admin), feedLinks: (userId, listId) => feedUrlsFor(d.env, userId, listId, d.now()) });
      return {
        jobTap: async (a: { userId: string; data: string; messageId: string | null; contact: string }) =>
          await tapJob({ userId: a.userId, data: a.data, messageId: a.messageId, deps: jd(), send: jobSenderFor(adapter, addressOf(a.contact)) }),
        showPostings: async (a: { userId: string; contact: string; hits: unknown[] }) =>
          await sendJobCards({ userId: a.userId, hits: a.hits as any[], deps: jd(), send: jobSenderFor(adapter, addressOf(a.contact)) }),
      };
    })() : {}),
    // REPLY SHAPE: a file and a link, each its own message (the link with its preview card).
    ...(adapter.sendDocument ? { sendFile: async (a: { contact: string; filename: string; mime: string; bytes: Uint8Array }) => await adapter.sendDocument!(addressOf(a.contact), a) } : {}),
    ...(adapter.sendLink ? { sendLink: async (a: { contact: string; url: string }) => await adapter.sendLink!(addressOf(a.contact), a.url) } : {}),
    ...(adapter.answerCallback ? { answerCallback: (id: string, text: string) => adapter.answerCallback!(id, text) } : {}),
    ...(admin && adapter.sendDocument ? {
      sendArtifacts: async (a: { userId: string; threadId: string | null; contact: string; artifacts: { ref: string }[] }) => {
        let sent = 0, failed = 0;
        for (const art of a.artifacts) {
          // Owner-scoped: this person's own artifact, in this thread; anything else reads as nothing and is not sent.
          const got = await fetchArtifactBytes(admin, { userId: a.userId, threadId: a.threadId, ref: art.ref });
          const r = got ? await adapter.sendDocument!(addressOf(a.contact), got) : { ok: false };
          if (r.ok) sent++; else failed++;
        }
        return { sent, failed };
      },
    } : {}),
  };
}

export async function handleTelegram(req: Request, d: ProviderWebhookDeps): Promise<Response> {
  const adapter = d.adapter ? d.adapter(d.env) : telegramAdapter({ token: d.env.get("TELEGRAM_BOT_TOKEN") || "", webhookSecret: d.env.get("TELEGRAM_WEBHOOK_SECRET") || "" });
  return await handleChannelWebhook(req, adapter, webhookDeps(adapter, d));
}
