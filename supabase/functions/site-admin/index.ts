// Trainee landing page — owner-only waitlist viewer (KEY-GATED endpoint). The handler and its rules (key only in the
// x-admin-key header, constant-time compare, no-store on every response) are in ./handler.ts;
// tests/architect/site-waitlist-functions.test.ts.
//
// verify_jwt is OFF: the key is the credential, checked on every request.
import { createAdminHandler } from "./handler.ts";

Deno.serve(createAdminHandler({ env: (k) => Deno.env.get(k), fetchFn: fetch }));
