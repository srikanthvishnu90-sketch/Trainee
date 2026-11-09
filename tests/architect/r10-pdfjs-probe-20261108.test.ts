// RELEASE 10 (architect ruling 2026-11-08): pdf.js stays behind a fallback, and the edge entry probes it once at startup and
// logs a failure (one JSON line, evt pdfjs_probe), so a staging check sees it. A probe that works logs nothing.
import { probePdfjs } from "../../supabase/functions/_shared/career_resume_geometry.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }

Deno.test("pdfjs-probe/1 pdf.js reads the probe page here, and a working probe logs nothing", async () => {
  const logs: string[] = [];
  const r = await probePdfjs({ log: (l) => logs.push(l) });
  assert(r.ok && r.error === null, JSON.stringify(r));
  assert(logs.length === 0, logs.join("\n"));
});

Deno.test("pdfjs-probe/2 a pdf.js that fails to load, or reads nothing, is logged as one JSON line, and never throws", async () => {
  const logs: string[] = [];
  const failed = await probePdfjs({ read: () => Promise.reject(new Error("Module not found: npm:pdfjs-dist")), log: (l) => logs.push(l) });
  assert(!failed.ok && /Module not found/.test(failed.error ?? ""), JSON.stringify(failed));
  const blank = await probePdfjs({ read: () => Promise.resolve({ items: [] } as never), log: (l) => logs.push(l) });
  assert(!blank.ok && /did not read/.test(blank.error ?? ""));
  assert(logs.length === 2 && logs.every((l) => JSON.parse(l).evt === "pdfjs_probe"), logs.join("\n"));
});

Deno.test("pdfjs-probe/3 the career edge entry runs the probe once, off the request path", async () => {
  const src = await Deno.readTextFile(new URL("../../supabase/functions/agent-chat/index-career.ts", import.meta.url));
  assert(/serve\(handleChat\);\n[\s\S]*probePdfjs\(\)\.catch\(\(\) => \{\}\);/.test(src), "probePdfjs() after serve, its failure swallowed");
});
