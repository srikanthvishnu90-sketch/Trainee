// Instinct harness: stands in for deno.land/std's http `serve` (import map, tests/instinct/import-map.json), so loading a
// deployed edge function's own index.ts hands its request handler to the harness instead of opening a port. The function
// itself (its composition of stores, adapters and clients) is exactly what deploys; only the listening socket is skipped.
// deno-lint-ignore-file no-explicit-any
type Handler = (req: Request, info?: unknown) => Response | Promise<Response>;
const g = globalThis as any;
g.__instinctServe ??= [] as Handler[];
export function serve(a: any, b?: any) {
  const h: Handler | undefined = typeof a === "function" ? a : typeof b === "function" ? b : a?.handler;
  if (h) g.__instinctServe.push(h);
  return { finished: Promise.resolve(), shutdown: async () => {} };
}
export default { serve };
