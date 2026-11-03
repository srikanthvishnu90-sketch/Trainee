// The sealed held-out set (2026-10-26). The items are in the repository only as ciphertext; what anyone can read is the
// public metadata (the SHA-256 of the plaintext, the item count, the count per category, who wrote it and when).
//
// How it is sealed: the item file is encrypted with a random 256-bit data key (AES-256-GCM). The data key is wrapped
// (X25519 + HKDF-SHA256 + AES-256-GCM) to a recipient whose private key is derived in CI from a repository secret
// (HKDF-SHA256 of the secret's value; nothing about the secret is stored). The author kept neither the plaintext nor
// the data key after sealing, so the set opens only where that secret is present: the brain-eval workflow.
//
//   deno run -A seal.ts pubkey --secret-env NAME                 (CI) print the recipient's public key for that secret
//   deno run -A seal.ts seal <plain.json> --to <recipient.json> --out <sealed.json> [--author "..."]
//   deno run -A seal.ts open <sealed.json> --out <plain.json>    (CI) needs one recipient's secret in the environment
//   deno run -A seal.ts rewrap <sealed.json> --secret-env NEW    (CI) add a recipient (needs an existing one's secret)
//   deno run -A seal.ts meta <sealed.json>                       the public metadata, and a check that it is well formed
//   deno run -A seal.ts check <plain.json>                       the item schema a sealed set must meet (before sealing)
import { checkItems } from "./schema.ts";

const enc = new TextEncoder(), dec = new TextDecoder();
type Bytes = Uint8Array<ArrayBuffer>;
export const FORMAT = "trainee-sealed-v1";
const b64 = (u: Bytes) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export async function sha256Hex(data: Bytes): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hkdf(ikm: Bytes, salt: Bytes, info: string, bytes = 32): Promise<Bytes> {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode(info) }, k, bytes * 8));
}
// The recipient key pair, from a secret's value: the same secret always gives the same pair.
export async function recipientFromSecret(secret: string): Promise<{ priv: CryptoKey; pub: string }> {
  if (!secret || secret.length < 16) throw new Error("the secret is missing or too short to derive a key from");
  const seed = await hkdf(enc.encode(secret), enc.encode("trainee-sealed-set/v1"), "x25519 recipient");
  const der = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20, ...seed]);
  const priv = await crypto.subtle.importKey("pkcs8", der, { name: "X25519" }, true, ["deriveBits"]);
  const jwk = await crypto.subtle.exportKey("jwk", priv);
  return { priv, pub: String(jwk.x) };
}
const pubKey = (x: string) => crypto.subtle.importKey("jwk", { kty: "OKP", crv: "X25519", x }, { name: "X25519" }, true, []);
async function wrapKey(dataKey: Bytes, recipientPub: string) {
  const eph = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKeyPair;
  const ephPub = String((await crypto.subtle.exportKey("jwk", eph.publicKey)).x);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: await pubKey(recipientPub) }, eph.privateKey, 256));
  const kek = await crypto.subtle.importKey("raw", await hkdf(shared, enc.encode(ephPub + recipientPub), "wrap data key"), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { pub: recipientPub, eph: ephPub, iv: b64(iv), wrapped: b64(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kek, dataKey))) };
}
async function unwrapKey(w: { pub: string; eph: string; iv: string; wrapped: string }, priv: CryptoKey): Promise<Bytes> {
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: await pubKey(w.eph) }, priv, 256));
  const kek = await crypto.subtle.importKey("raw", await hkdf(shared, enc.encode(w.eph + w.pub), "wrap data key"), "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(w.iv) }, kek, unb64(w.wrapped)));
}
export type Sealed = {
  format: string; sha256: string; items: number; categories: Record<string, number>; author: string; sealed_at: string; note: string;
  recipients: { secret_env: string; pub: string; eph: string; iv: string; wrapped: string }[]; iv: string; ciphertext: string;
};
export async function seal(plain: Bytes, to: { secret_env: string; pub: string }[], meta: { author: string; note: string }): Promise<Sealed> {
  const set = JSON.parse(dec.decode(plain));
  const bad = checkItems(set);
  if (bad.length) throw new Error(`not sealed: ${bad.length} schema problems, first: ${bad[0]}`);
  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey("raw", dataKey, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const categories: Record<string, number> = {};
  for (const it of set.items) categories[it.category] = (categories[it.category] ?? 0) + 1;
  const recipients = [];
  for (const r of to) recipients.push({ secret_env: r.secret_env, ...(await wrapKey(dataKey, r.pub)) });
  dataKey.fill(0);
  return { format: FORMAT, sha256: await sha256Hex(plain), items: set.items.length, categories, author: meta.author, sealed_at: new Date().toISOString(), note: meta.note, recipients, iv: b64(iv), ciphertext: b64(ct) };
}
export async function open(s: Sealed, env: { get(k: string): string | undefined }): Promise<Bytes> {
  if (s.format !== FORMAT) throw new Error(`unknown format ${s.format}`);
  for (const r of s.recipients) {
    const secret = env.get(r.secret_env);
    if (!secret) continue;
    const me = await recipientFromSecret(secret);
    if (me.pub !== r.pub) throw new Error(`the ${r.secret_env} here is not the one this set was sealed to (the secret was changed: rewrap it with the old one first)`);
    const dataKey = await unwrapKey(r, me.priv);
    const key = await crypto.subtle.importKey("raw", dataKey, "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(s.iv) }, key, unb64(s.ciphertext)));
    if (await sha256Hex(plain) !== s.sha256) throw new Error("the opened set does not match its recorded SHA-256");
    return plain;
  }
  throw new Error(`no recipient secret is set here (needs one of: ${s.recipients.map((r) => r.secret_env).join(", ")})`);
}
export async function rewrap(s: Sealed, env: { get(k: string): string | undefined }, secretEnv: string): Promise<Sealed> {
  const plain = await open(s, env); // proves an existing recipient opens it and the plaintext matches its hash
  // The data key is recovered from an existing recipient, then wrapped to the new one; the ciphertext is unchanged.
  const r0 = s.recipients.find((r) => env.get(r.secret_env));
  const me = await recipientFromSecret(env.get(r0!.secret_env)!);
  const dataKey = await unwrapKey(r0!, me.priv);
  const next = await recipientFromSecret(env.get(secretEnv) ?? "");
  const added = { secret_env: secretEnv, ...(await wrapKey(dataKey, next.pub)) };
  dataKey.fill(0); plain.fill(0);
  return { ...s, recipients: [...s.recipients.filter((r) => r.secret_env !== secretEnv), added] };
}
export function metaProblems(s: Sealed): string[] {
  const p: string[] = [];
  if (s.format !== FORMAT) p.push("format");
  if (!/^[0-9a-f]{64}$/.test(s.sha256 ?? "")) p.push("sha256");
  if (!(s.items >= 150)) p.push(`items: ${s.items} (needs 150 or more)`);
  const sum = Object.values(s.categories ?? {}).reduce((a, b) => a + b, 0);
  if (sum !== s.items) p.push(`categories add to ${sum}, not ${s.items}`);
  if (!Array.isArray(s.recipients) || !s.recipients.length) p.push("recipients");
  if (!s.ciphertext || !s.iv) p.push("ciphertext");
  return p;
}

if (import.meta.main) {
  const [cmd, file] = Deno.args, opt = (n: string) => { const i = Deno.args.indexOf(n); return i >= 0 ? Deno.args[i + 1] ?? null : null; };
  if (cmd === "pubkey") {
    const name = opt("--secret-env");
    if (!name) { console.log("usage: seal.ts pubkey --secret-env NAME"); Deno.exit(2); }
    const r = await recipientFromSecret(Deno.env.get(name) ?? "");
    console.log(JSON.stringify({ secret_env: name, pub: r.pub, derived_at: new Date().toISOString() }));
  } else if (cmd === "seal") {
    const to = JSON.parse(await Deno.readTextFile(opt("--to")!));
    const s = await seal(await Deno.readFile(file), Array.isArray(to) ? to : [to], { author: opt("--author") ?? "unknown", note: opt("--note") ?? "" });
    await Deno.writeTextFile(opt("--out")!, JSON.stringify(s, null, 1) + "\n");
    console.log(`sealed ${s.items} items · sha256 ${s.sha256} · ${JSON.stringify(s.categories)}`);
  } else if (cmd === "open") {
    const s: Sealed = JSON.parse(await Deno.readTextFile(file));
    const plain = await open(s, Deno.env);
    const bad = checkItems(JSON.parse(dec.decode(plain)));
    if (bad.length) { console.log(`OPENED BUT INVALID: ${bad.length} schema problems (not listed: they would print item text)`); Deno.exit(1); }
    await Deno.writeFile(opt("--out")!, plain);
    console.log(`opened ${s.items} items · sha256 ${s.sha256} verified`);
  } else if (cmd === "rewrap") {
    const s: Sealed = JSON.parse(await Deno.readTextFile(file));
    const next = await rewrap(s, Deno.env, opt("--secret-env")!);
    await Deno.writeTextFile(file, JSON.stringify(next, null, 1) + "\n");
    console.log(`recipients: ${next.recipients.map((r) => r.secret_env).join(", ")}`);
  } else if (cmd === "meta") {
    const s: Sealed = JSON.parse(await Deno.readTextFile(file));
    const p = metaProblems(s);
    console.log(JSON.stringify({ format: s.format, sha256: s.sha256, items: s.items, categories: s.categories, author: s.author, sealed_at: s.sealed_at, recipients: s.recipients.map((r) => r.secret_env), problems: p }));
    if (p.length) Deno.exit(1);
  } else if (cmd === "check") {
    const bad = checkItems(JSON.parse(await Deno.readTextFile(file)));
    for (const b of bad.slice(0, 40)) console.log(b);
    console.log(bad.length ? `${bad.length} problems` : "schema ok");
    if (bad.length) Deno.exit(1);
  } else { console.log("usage: seal.ts pubkey|seal|open|rewrap|meta|check ..."); Deno.exit(2); }
}
