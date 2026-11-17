// career-cloud-runner (F-RUNNER, FEATURE 17; docs/launch/CLOUD-RUNNER.md): the cloud runner's dispatchers and bridges,
// for sending approved applications and for preparing the card a person asked for. Routes and switches:
// ../_shared/cloud_runner_http.ts. Logic and tests: ../_shared/cloud_runner.ts, ../_shared/cloud_prepare.ts,
// tests/architect/cloud-runner.test.ts, tests/architect/flow-hosted-apply.test.ts.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { createRunnerHandler } from "../_shared/cloud_runner_http.ts";
import { supabaseBatchFile, supabaseReviewLinks } from "../_shared/application_review_links.ts";

// A preparation started by the chat's kick keeps running after the 202 (the edge runtime's waitUntil); the minute's tick
// picks up any request it did not start.
// deno-lint-ignore no-explicit-any
const edge = (globalThis as any).EdgeRuntime;
// WO-G: each pushed card carries the review File link of every application on it (application_review_links.ts).
const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const admin = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
const review = admin ? supabaseReviewLinks(admin, Deno.env) : undefined;
// D-094: a batch too big for one card text is ONE card, a short summary plus the File of every application with its exact payload.
const batchFile = admin ? supabaseBatchFile(admin, Deno.env) : undefined;
Deno.serve(createRunnerHandler({ batchFile, env: Deno.env, waitUntil: (p) => edge?.waitUntil ? edge.waitUntil(p) : void p, review }));
