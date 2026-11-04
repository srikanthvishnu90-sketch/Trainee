// career-cloud-runner (F-RUNNER, FEATURE 17; docs/launch/CLOUD-RUNNER.md): the cloud runner's dispatchers and bridges,
// for sending approved applications and for preparing the card a person asked for. Routes and switches:
// ../_shared/cloud_runner_http.ts. Logic and tests: ../_shared/cloud_runner.ts, ../_shared/cloud_prepare.ts,
// tests/architect/cloud-runner.test.ts, tests/architect/flow-hosted-apply.test.ts.
import { createRunnerHandler } from "../_shared/cloud_runner_http.ts";

// A preparation started by the chat's kick keeps running after the 202 (the edge runtime's waitUntil); the minute's tick
// picks up any request it did not start.
// deno-lint-ignore no-explicit-any
const edge = (globalThis as any).EdgeRuntime;
Deno.serve(createRunnerHandler({ env: Deno.env, waitUntil: (p) => edge?.waitUntil ? edge.waitUntil(p) : void p }));
