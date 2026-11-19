// MASS APPLY CONVERSATIONS (2026-11-17, ag/ma-07-yes-route): the reply to a card's yes says what will actually happen to EACH
// approved application, by the route that application really takes, never one line for the person as a whole and never
// "from your computer or, if you turned it on, the cloud" when the route can be read (D-024: say what will happen, or say it
// is unconfirmed). Read-only: nothing here approves, queues, claims or sends; the database's own claims decide, and this
// module only reads the same inputs they check, in the same order:
//   the person's cloud opt-in (career_apply_cloud_optin_get)             off: their computer sends it
//   the cloud's switches (release flags and CAREER_AGENT_SUBMIT,
//     CAREER_CLOUD_APPLY, CAREER_CLOUD_TEXT_CARDS; chat_switches.ts)     off: the cloud can't, their computer sends it
//   the posting's ATS family (career_apply_portal: the cloud submits on
//     Greenhouse, Lever, Ashby and SmartRecruiters only)                 another site: the cloud can't, their computer sends it
//   the employer's https destination (career_apply_cloud_destination_ok) none: a form only the person can submit
//   the family's gate (career_apply_cloud_open, or the person's waiver
//     with sends left, career_apply_cloud_waiver_left)                   closed: the cloud can't yet, their computer sends it
// Anything unreadable is "unknown", and the reply says the route is unconfirmed.
export type ItemRoute = { via: "cloud" } | { via: "computer" } | { via: "not_cloud"; why: string } | { via: "unknown" };

// The families the cloud submits on (20261021080000 career_apply_portal, 20261108120000 SmartRecruiters).
export const CLOUD_FAMILIES = ["greenhouse", "lever", "ashby", "smartrecruiters"] as const;
const FAMILY_NAME: Record<string, string> = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", smartrecruiters: "SmartRecruiters" };

// The portal family of a posting link exactly as the database derives it (career_apply_portal: https only, the host, no user
// part, a port allowed). Anything else is null.
export function portalOf(url: unknown): string | null {
  const h = /^https:\/\/([^/?#:@]+)(?::[0-9]+)?(?:[/?#]|$)/.exec(String(url ?? ""))?.[1]?.toLowerCase();
  if (!h) return null;
  if (/(^|\.)greenhouse\.io$/.test(h)) return "greenhouse";
  if (/(^|\.)lever\.co$/.test(h)) return "lever";
  if (/(^|\.)ashbyhq\.com$/.test(h)) return "ashby";
  if (/(^|\.)smartrecruiters\.com$/.test(h)) return "smartrecruiters";
  return null;
}
const hostOf = (url: unknown) => { try { return new URL(String(url ?? "")).hostname.toLowerCase() || null; } catch { return null; } };

export interface RouteFacts {
  optIn: boolean | null;       // the person's cloud opt-in; null: unreadable
  cloudOn: boolean | null;     // every cloud switch on; false: one is off; null: unreadable
  url: string | null;          // the prepared application's posting link
  destinationOk: boolean | null; // the payload names the employer's https endpoint
  gateOpen: boolean | null;    // the family's gate is open, or the person holds a waiver with sends left
}
// One application's route, from what the database's claim checks. Pure.
export function routeOf(f: RouteFacts): ItemRoute {
  if (f.optIn === false) return { via: "computer" };
  if (f.optIn !== true) return { via: "unknown" };
  if (f.cloudOn === false) return { via: "not_cloud", why: "Trainee's cloud sending is switched off right now" };
  if (f.cloudOn !== true) return { via: "unknown" };
  const fam = portalOf(f.url);
  if (!fam) return { via: "not_cloud", why: `Trainee's cloud does not submit on ${hostOf(f.url) ?? "that site"} (it submits on Greenhouse, Lever, Ashby and SmartRecruiters)` };
  if (f.destinationOk === false) return { via: "not_cloud", why: "the employer's form there is one only you can submit" };
  if (f.destinationOk !== true) return { via: "unknown" };
  if (f.gateOpen === false) return { via: "not_cloud", why: `Trainee's cloud is not open for ${FAMILY_NAME[fam]} applications yet` };
  if (f.gateOpen !== true) return { via: "unknown" };
  return { via: "cloud" };
}

// What the yes reply says for one approved application on that route.
const FROM_COMPUTER = "it is sent from your computer the next time Trainee's extension or desktop app is open there";
export function routeLine(r: ItemRoute | null | undefined): string {
  if (!r || r.via === "unknown") return "approved; how it is sent is unconfirmed right now (from your computer, or the cloud if you turned it on)";
  // A forecast, not proof (D-024): the cloud's claim checks more at send time than this reads (the resume in the cloud, a
  // stale application, a closed posting, pauses, the daily pace, the 24-hour approval window), so it is said as not yet
  // confirmed; the receipt is the proof.
  if (r.via === "cloud") return "approved; Trainee's cloud should send it, on its own, but that is not confirmed yet (it checks the application again before it sends); ask \"did they go through?\" for its receipt";
  if (r.via === "computer") return `approved; ${FROM_COMPUTER} (the cloud is off for you)`;
  return `approved; the cloud can't send it because ${r.why}, so ${FROM_COMPUTER}`;
}

// The route of each of these prepared applications (by id), read with the service client. `cloudOn` reads the switches
// (chat_switches.ts: release flags and the database's rows). Every read is bounded by the card's own items; one that fails
// leaves the routes it decides "unknown", never guessed.
// deno-lint-ignore no-explicit-any
export async function supabaseSendRoutes(admin: any, userId: string, preparedIds: string[], o: { now: number; cloudOn: () => Promise<boolean | null> }): Promise<Map<string, ItemRoute>> {
  const ids = [...new Set(preparedIds)];
  const out = new Map<string, ItemRoute>(ids.map((id) => [id, { via: "unknown" } as ItemRoute]));
  if (!ids.length) return out;
  const optIn = await admin.rpc("career_apply_cloud_optin_get", { p_user: userId }).then((r: any) => r?.error ? null : r?.data?.enabled === true, () => null);
  const cloudOn = optIn === true ? await o.cloudOn().catch(() => null) : null;
  type PreparedRow = { id: string; url: string | null; destination: string | null };
  const rows: PreparedRow[] | null = await admin.from("career_apply_prepared").select("id,url,destination:payload->>destination").eq("user_id", userId).in("id", ids)
    .then((r: any) => (r?.error ? null : (r?.data ?? []) as PreparedRow[]), () => null);
  // The applications unreadable: only "the cloud is off for you" is still known.
  if (!rows) {
    if (optIn === false) for (const id of ids) out.set(id, { via: "computer" });
    return out;
  }
  // The gate, once per family on this card (at most four reads, and none unless the cloud could take it).
  const gate = new Map<string, boolean | null>();
  if (optIn === true && cloudOn === true) {
    const families = new Set<string>(rows.map((r: PreparedRow) => portalOf(r.url)).filter((f: string | null): f is string => !!f));
    for (const fam of families) {
      const open = await admin.rpc("career_apply_cloud_open", { p_portal: fam }).then((r: any) => (r?.error ? null : r?.data === true), () => null);
      const left = open === false
        ? await admin.rpc("career_apply_cloud_waiver_left", { p_user: userId, p_portal: fam, p_now: new Date(o.now).toISOString() }).then((r: any) => (r?.error ? null : Number(r?.data)), () => null)
        : null;
      gate.set(fam, open === true ? true : open === false ? (left === null || !Number.isFinite(left) ? null : left > 0) : null);
    }
  }
  for (const r of rows) {
    const fam = portalOf(r.url);
    out.set(String(r.id), routeOf({ optIn, cloudOn, url: r.url ?? null, destinationOk: /^https:\/\//.test(String(r.destination ?? "")), gateOpen: fam ? gate.get(fam) ?? null : null }));
  }
  return out;
}
