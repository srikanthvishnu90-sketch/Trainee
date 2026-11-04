// The owner's clear-yes forms that no approval parser read (owner rules, 2026-10-29; tests/architect/scenarios-approvals.test.ts):
// a message that is only a thumbs-up (any skin tone, repeated), or only "yess"/"yesss"/"yse", is the word "yes". Only the
// WHOLE message is rewritten (trailing . or ! kept), so "👍 but not 2" or "yess maybe" stay what they were and each
// parser reads them as before. Every other text is returned unchanged.
const THUMBS = /^(?:\u{1F44D}[\u{1F3FB}-\u{1F3FF}]?\u{FE0F}?)+\s*([.!]*)$/u;
const TYPO = /^(?:yes{2,}|yse)\s*([.!]*)$/i;
export function approvalWords(text: string): string {
  const raw = String(text ?? "");
  const t = raw.trim();
  const thumbs = THUMBS.exec(t);
  if (thumbs) return `yes${thumbs[1]}`;
  const m = TYPO.exec(t);
  return m ? `yes${m[1]}` : raw;
}
