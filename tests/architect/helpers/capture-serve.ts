// Stands in for https://deno.land/std@0.208.0/http/server.ts in the gmail-oauth wrapper harness only (mapped by the
// harness's import map): serve() keeps the handler the function gives it instead of listening, so the harness can call it.
export function serve(handler: (req: Request) => Response | Promise<Response>, _opts?: unknown): Promise<void> {
  // deno-lint-ignore no-explicit-any
  (globalThis as any).__gmailOauthHandler = handler;
  return new Promise(() => {});
}
