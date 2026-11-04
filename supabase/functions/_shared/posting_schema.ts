// MASS APPLY (2026-11-01): a posting's application form read from the ATS's public board API, without a browser, cached.
// Greenhouse publishes every question of a posting (boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}?questions=true:
// labels, required, field names, types and option values); Lever's postings API and Ashby's posting API publish the posting
// but not its application questions, so those (and any Greenhouse read that fails) answer null: the browser reads the form.
// Read-only, one GET per posting per TTL. What this returns is the form's shape only; it is never an answer and never a
// payload (the engine still fills and checks the live form before anything is sent).
export interface SchemaField { name: string; label: string; required: boolean; type: string; options: { label: string; value: string }[] }
export interface PostingSchema { source: "greenhouse_boards_api"; fields: SchemaField[]; read_at: number }
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

// The board API link for a posting link, or null when the ATS publishes no questions.
export function schemaUrlFor(url: string, o: { greenhouseApi?: string } = {}): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const m = /^\/(?:embed\/job_app\?for=)?([A-Za-z0-9_-]+)\/jobs\/(\d+)/.exec(u.pathname);
  const gh = /(^|\.)greenhouse\.io$/.test(u.hostname) || (o.greenhouseApi && u.origin === new URL(o.greenhouseApi).origin);
  if (!gh || !m) return null;
  return `${o.greenhouseApi ?? "https://boards-api.greenhouse.io"}/v1/boards/${m[1]}/jobs/${m[2]}?questions=true`;
}

export function schemaFromGreenhouse(json: any): SchemaField[] | null {
  if (!json || !Array.isArray(json.questions)) return null;
  const out: SchemaField[] = [];
  for (const q of json.questions) {
    for (const f of Array.isArray(q?.fields) ? q.fields : []) {
      if (typeof f?.name !== "string" || !f.name) continue;
      out.push({ name: f.name, label: String(q.label ?? ""), required: q.required === true && !/_text$/.test(f.name), type: String(f.type ?? ""),
        options: (Array.isArray(f.values) ? f.values : []).map((v: any) => ({ label: String(v?.label ?? ""), value: String(v?.value ?? "") })) });
    }
  }
  return out;
}

export function schemaCache(ttlMs = 6 * 3600_000, now: () => number = Date.now) {
  const m = new Map<string, PostingSchema | null>(), at = new Map<string, number>();
  return {
    get: (k: string) => (at.has(k) && now() - at.get(k)! < ttlMs ? m.get(k) : undefined),
    put: (k: string, v: PostingSchema | null) => { m.set(k, v); at.set(k, now()); },
  };
}

// The schema, from the cache or one GET; null (use the browser) when the ATS publishes none or the read fails.
export async function postingSchema(url: string, d: { fetch: Fetch; cache?: ReturnType<typeof schemaCache>; greenhouseApi?: string; now?: () => number }): Promise<PostingSchema | null> {
  const api = schemaUrlFor(url, { greenhouseApi: d.greenhouseApi });
  if (!api) return null;
  const hit = d.cache?.get(api);
  if (hit !== undefined) return hit;
  let v: PostingSchema | null = null;
  try {
    const r = await d.fetch(api, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    const fields = r.ok ? schemaFromGreenhouse(await r.json()) : null;
    v = fields ? { source: "greenhouse_boards_api", fields, read_at: (d.now ?? Date.now)() } : null;
  } catch { v = null; }
  d.cache?.put(api, v);
  return v;
}
