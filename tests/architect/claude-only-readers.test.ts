// Owner directive 2026-11-02 18:38 CT: Trainee is Claude-only, no OpenAI calls anywhere, voice stays off. This file holds
// the cross-cutting checks for the background readers (mail second pass, essay drafts, mock-prep judge, outreach replies)
// and voice: no OpenAI host, key or model id in their code; the consent and privacy copy names Anthropic, says what is
// sent, claims nothing about the provider's retention beyond "under Anthropic's API terms", and no longer says store:false
// or names OpenAI. Per-reader behaviour on the fake Anthropic wire is in wo-040/wo-051 (mail), wo-049 (essay), f11-mock-prep
// (mock judge), m5-outreach-replies (replies); voice is in wo-035-voice-mock.
import { consentNotice } from "../../supabase/functions/_shared/google_scopes.ts";
import { readerModel, readerModelConfig } from "../../supabase/functions/_shared/career_reader_model.ts";
import { mailModelConfig } from "../../supabase/functions/_shared/career_mail_model.ts";
import { essayModelConfig } from "../../supabase/functions/_shared/career_essay_card.ts";

function assert(v: unknown, m = "assertion failed") { if (!v) throw new Error(m); }
const eq = (a: unknown, b: unknown, m = "") => assert(JSON.stringify(a) === JSON.stringify(b), `${m} ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const root = new URL("../../", import.meta.url);
const read = (p: string) => Deno.readTextFileSync(new URL(p, root));
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n").replace(/<!--[\s\S]*?-->/g, "");

const READERS = [
  "supabase/functions/_shared/career_mail_model.ts", "supabase/functions/_shared/career_essay_card.ts", "supabase/functions/career-essay-draft/index.ts",
  "supabase/functions/_shared/career_mock_prep.ts", "supabase/functions/career-proactive/index.ts", "supabase/functions/_shared/career_reader_model.ts",
  "supabase/functions/_shared/career_outreach_replies.ts", "supabase/functions/_shared/career_tailor_rewrite.ts",
  "supabase/functions/_shared/career_voice.ts", "supabase/functions/_shared/career_voice_link.ts", "supabase/functions/career-voice/index.ts", "voice/mock.html",
];

Deno.test("claude-only: no reader or voice file names OpenAI, a provider key, a gpt id, a realtime URL or store:false", () => {
  for (const f of READERS) {
    const t = code(read(f));
    assert(!/openai|OPENAI_API_KEY|gpt-\d|realtime|client_secrets|whisper|transcribe/i.test(t), `${f} names OpenAI or a voice model`);
    assert(!/store\s*:\s*false/.test(t), `${f} still sends store:false`);
    assert(!/api\.anthropic\.com/.test(t), `${f}: only the gateway names a provider URL`);
  }
});

Deno.test("claude-only: every reader's config is Claude on Anthropic's key, whatever CAREER_MODEL, MODEL_PROVIDER and OPENAI_* say", () => {
  const e = (o: Record<string, string>) => ({ get: (k: string) => o[k] });
  for (const o of [{}, { CAREER_MODEL: "gpt-5-mini" }, { CAREER_MODEL: "o3" }, { MODEL_PROVIDER: "openai", OPENAI_MODEL: "gpt-5-nano", OPENAI_API_KEY: "o" }]) {
    for (const cfg of [readerModelConfig(e({ ...o, ANTHROPIC_API_KEY: "a" })), mailModelConfig(e({ ...o, ANTHROPIC_API_KEY: "a" })), essayModelConfig(e({ ...o, ANTHROPIC_API_KEY: "a" }))]) {
      eq([cfg.provider, cfg.model, cfg.apiKey], ["anthropic", "claude-sonnet-5-5", "a"], JSON.stringify(o)); // D-046: Sonnet only
    }
    eq(readerModelConfig(e(o)).apiKey, "", `no Anthropic key: not configured, an OpenAI key is not a key (${JSON.stringify(o)})`);
  }
  eq(readerModel(e({ CAREER_MODEL: " claude-sonnet-5-5 " })), "claude-sonnet-5-5");
});

Deno.test("claude-only: the consent notice names Anthropic, says what is sent, and claims nothing about the provider's retention", () => {
  const withCheck = consentNotice(["https://www.googleapis.com/auth/gmail.readonly"], { modelCheck: true });
  const line = withCheck.reads.find((r) => /unclear/.test(r)) ?? "";
  assert(/Anthropic's API/.test(line) && /sender name, subject and preview/.test(line) && /masked/.test(line), line);
  assert(/under Anthropic's API terms/.test(line) && /Trainee stores nothing from that beyond the result it confirms/.test(line), line);
  assert(!/openai|does not train|never stored at|zero retention|not retained|deleted after/i.test(JSON.stringify(withCheck)), "no OpenAI and no retention claim about the provider");
  const without = consentNotice(["https://www.googleapis.com/auth/gmail.readonly"]);
  assert(!/Anthropic|model/i.test(without.reads.join(" ")), "without the model check, no model is mentioned");
});

Deno.test("claude-only: the published privacy policy and the app's copy name Anthropic as the AI provider, not OpenAI", () => {
  for (const f of ["privacy.html", "src/upmore-app-template.html", "src/upmore-app.html", "index.html"]) {
    const t = read(f);
    assert(!/<strong>OpenAI<\/strong>|OpenAI, or Anthropic|OpenAI \(and Anthropic/.test(t), `${f} still names OpenAI as a processor`);
    assert(/Anthropic/.test(t) && /Anthropic's API terms/.test(t), `${f} says what Anthropic keeps is under its API terms`);
  }
  const p = read("privacy.html");
  assert(!/does not train|not used to train their models by default/.test(p.slice(p.indexOf("<strong>Anthropic</strong>"), p.indexOf("<strong>Anthropic</strong>") + 900)), "no claim about the provider's training or retention beyond 'governed by its API terms'");
});
