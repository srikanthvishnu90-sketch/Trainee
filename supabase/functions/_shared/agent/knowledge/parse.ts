// Situation playbooks: the markdown files in knowledge/playbooks/ are the source; scripts/build-playbooks.ts compiles them
// into playbooks.generated.ts (an edge function ships .ts, not loose .md files). This parser is shared by the build and the
// lint test, so a file the build accepts is a file the lint reads the same way.
export type PlaybookKind = "core" | "stage" | "situation" | "context" | "employer" | "method" | "interview" | "offer" | "emotional";
export interface Playbook {
  id: string;
  kind: PlaybookKind;
  // `when`: any one of these makes the playbook eligible; an item "a+b" needs both signals. `boost`: each adds a little.
  when: string[];
  boost: string[];
  // The body without the front matter: "## Principles", "## Steps", "## Ask", "## Do not claim".
  body: string;
}
export const KINDS: readonly PlaybookKind[] = ["core", "stage", "situation", "context", "employer", "method", "interview", "offer", "emotional"];
export const SECTIONS = ["Principles", "Steps", "Ask", "Do not claim"] as const;

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
export function parsePlaybook(md: string, file = "playbook"): Playbook {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(md.replace(/\r\n/g, "\n"));
  if (!m) throw new Error(`${file}: no front matter`);
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  if (!meta.id || !/^[a-z0-9-]+$/.test(meta.id)) throw new Error(`${file}: bad id`);
  if (!KINDS.includes(meta.kind as PlaybookKind)) throw new Error(`${file}: bad kind ${meta.kind}`);
  return { id: meta.id, kind: meta.kind as PlaybookKind, when: list(meta.when), boost: list(meta.boost), body: m[2].trim() };
}
