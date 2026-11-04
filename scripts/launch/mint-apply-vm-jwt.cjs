#!/usr/bin/env node
"use strict";
// Mints the worker's key: an HS256 JWT whose role is apply_vm_worker (a role that can run the apply VM functions and read no
// table). Run it ON YOUR OWN COMPUTER with the project's JWT secret in the environment; the secret and the output are never
// written to a file, the repo or chat:
//   SUPABASE_JWT_SECRET=... node scripts/launch/mint-apply-vm-jwt.cjs [days=90]
// If the project signs with the newer asymmetric keys instead of a JWT secret, this key will not be accepted: use the runbook's
// fallback (the service key for the first stage only) and say so.
const crypto = require("node:crypto");
const secret = process.env.SUPABASE_JWT_SECRET;
if (!secret) { console.error("Set SUPABASE_JWT_SECRET in the environment (not on the command line)."); process.exit(2); }
const days = Number(process.argv[2] || 90);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role: "apply_vm_worker", iss: "supabase", iat: now, exp: now + days * 86400 })}`;
process.stdout.write(`${body}.${crypto.createHmac("sha256", secret).update(body).digest("base64url")}\n`);
