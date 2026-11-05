// Trainee landing page — waitlist survey capture (PUBLIC endpoint). The handler and its rules (the phone must be on the
// waitlist, one survey per phone, source kept as a path only) are in ./handler.ts;
// tests/architect/site-waitlist-functions.test.ts.
//
// verify_jwt is OFF on purpose: this is a public capture endpoint and the
// page ships no credentials.
import { createSurveyHandler } from "./handler.ts";

Deno.serve(createSurveyHandler({ env: (k) => Deno.env.get(k), fetchFn: fetch }));
