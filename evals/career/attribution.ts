// Route attribution: for each failed item, who answered its last turn, the code router or the model? (Plan finding 4: in
// ten stored staged passes 41 of 49 failures were router-answered, so a model swap could not have fixed them.) Free: it reads
// the traces the runs already keep, and never calls a model.
//
// Route of an item = the route of the last trace entry (staged records "brain", "router" or "router_fallback" per turn that
// reached the brain host). With no trace: the router brain is "router", the agent brain is "brain", anything else "unknown".
export type Route = "brain" | "router" | "router_fallback" | "unknown";
type Item = { id: string; pass: boolean; trace?: { route?: string }[] };
export interface Attribution {
  brain: string; items: number; failed: number;
  by_route: Record<Route, { items: number; failed: number }>;
  failed_ids: Record<Route, string[]>;
  failed_router_share: number | null; // failures answered by code (router + router_fallback) / all failures
  model_pass_rate: number | null;     // pass rate of the items the model answered
}
const ROUTES: Route[] = ["brain", "router", "router_fallback", "unknown"];

export function routeOf(item: Item, brain: string): Route {
  const r = item.trace?.length ? item.trace[item.trace.length - 1].route : undefined;
  if (r === "brain" || r === "router" || r === "router_fallback") return r;
  const base = brain.split(":")[0];
  return base === "router" ? "router" : base === "agent" ? "brain" : "unknown";
}

export function attribute(items: Item[], brain: string): Attribution {
  const by_route = Object.fromEntries(ROUTES.map((r) => [r, { items: 0, failed: 0 }])) as Attribution["by_route"];
  const failed_ids = Object.fromEntries(ROUTES.map((r) => [r, [] as string[]])) as Attribution["failed_ids"];
  for (const it of items) {
    const r = routeOf(it, brain);
    by_route[r].items++;
    if (!it.pass) { by_route[r].failed++; failed_ids[r].push(it.id); }
  }
  const failed = items.filter((x) => !x.pass).length;
  const code = by_route.router.failed + by_route.router_fallback.failed;
  return { brain, items: items.length, failed, by_route, failed_ids,
    failed_router_share: failed ? code / failed : null,
    model_pass_rate: by_route.brain.items ? 1 - by_route.brain.failed / by_route.brain.items : null };
}

export function attributionLines(a: Attribution): string[] {
  const parts = ROUTES.filter((r) => a.by_route[r].items).map((r) => `${r} ${a.by_route[r].items - a.by_route[r].failed}/${a.by_route[r].items} passed`);
  return [`route attribution (${a.brain}): ${a.failed} failed of ${a.items}; ${parts.join(", ")}` +
    (a.failed_router_share === null ? "" : `; ${(a.failed_router_share * 100).toFixed(0)}% of failures were answered by code, so a model change cannot fix them`) +
    (a.model_pass_rate === null ? "" : `; the model passed ${(a.model_pass_rate * 100).toFixed(1)}% of its own items`)];
}

// Several passes of one brain: summed counts.
export function attributeMany(passes: { items: Item[] }[], brain: string): Attribution {
  return attribute(passes.flatMap((p) => p.items), brain);
}
