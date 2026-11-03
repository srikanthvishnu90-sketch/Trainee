// Shared helpers for the model-call tests: the user id they run as and an async-rejection assertion.
function assert(v: unknown, m = "assertion failed") { if (!v) throw new Error(m); }
export async function rejects(fn: () => unknown | Promise<unknown>, part: string) {
  try { await fn(); } catch (e) { assert(String(e).includes(part), String(e)); return; }
  throw new Error("expected rejection: " + part);
}
export const user = "00000000-0000-4000-8000-000000000001";
