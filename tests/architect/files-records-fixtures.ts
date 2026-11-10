// Item 6, S5: one person's records for the record-backed File families (file_family_records.ts), and a person with none.
import type { Records } from "../../supabase/functions/_shared/file_family_records.ts";
export const NOW = Date.parse("2026-11-10T15:00:00Z");
export const FULL: Records = {
  now: NOW, tz: "America/Chicago",
  account: { version: 7, stated_facts: { updated_at: "2026-11-08T12:00:00Z", facts: [
    { kind: "level", value: "Analyst", evidence: "I want analyst roles", at: "2026-11-01T10:00:00Z" },
    { kind: "geography", value: "New York", evidence: "in New York", at: "2026-11-01T10:00:00Z" },
    { kind: "target_firm", value: "Evercore", evidence: "Evercore", at: "2026-11-02T10:00:00Z" },
    { kind: "sponsorship", value: "needs sponsorship", evidence: "I need sponsorship", at: "2026-11-02T10:00:00Z" },
  ] }, memory: { profile: { facts: [
    { id: "f1", kind: "education", title: "BS Economics, Rutgers University", status: "confirmed", confirmed_at: "2026-10-30T09:00:00Z" },
    { id: "f2", kind: "experience", title: "Summer analyst, Small Bank", status: "draft", needs_confirmation: true },
  ] } } },
  standing: [{ text: "No staffing agencies", at: "2026-11-03T10:00:00Z" }],
  questions: [
    { key: "fact:phone_type", kind: "fact", label: "Preferred phone type", company: null, state: "answered", answer: "Mobile", answered_at: "2026-11-04T10:00:00Z" },
    { key: "job:aaaaaaaaaaaaaaaa", kind: "essay", label: "Why Evercore?", company: "Evercore", state: "answered", answer: "Because of its advisory focus", answered_at: "2026-11-05T10:00:00Z" },
    { key: "label:bbbbbbbbbbbbbbbb", kind: "attestation", label: "I certify the information is accurate", company: "Lazard", state: "open", answer: null, answered_at: null },
    { key: "fact:work_authorization", kind: "screen", label: "Are you authorized to work in the US?", company: null, state: "answered", answer: "Yes", answered_at: "2026-11-05T10:00:00Z" },
  ],
  interviews: [{ company: "Evercore", role: "Analyst first round", source: "mail", when_said: ["Tue 2pm", "Wed 10am"], interview_date: "2026-11-12", interview_time: "14:00", zone: "America/New_York",
    starts_at: "2026-11-12T19:00:00Z", format: "video", interviewers: [{ name: "Dana Park", title: "Vice President" }], seen_at: "2026-11-09T10:00:00Z" }],
  digest: { enabled: true, day: 0, hour: 18, tz: "America/Chicago" },
  events: [{ at: "2026-11-09T10:00:00Z", kind: "search", subject: "analyst" }, { at: "2026-11-09T11:00:00Z", kind: "application_approved", subject: "Evercore" }],
  offers: [{ offer: { company: "Evercore", role: "Analyst", base: 110000, signing: 15000, bonus: null, bonus_pct: null, city: "New York", deadline: { text: "Friday" } }, equity: null, said: "Evercore offered 110k base, 15k signing", at: NOW - 86400_000 }],
};
export const NONE: Records = { now: NOW, tz: null, account: null, standing: [], questions: [], interviews: [], digest: null, events: [], offers: [] };

