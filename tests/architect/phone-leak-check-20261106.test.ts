// The file-page batteries' phone check (tests/architect/phone-leak.ts), both ways:
// (1) every form a person could read is still a leak, readable URLs of any length included (Greptile on #562: the first fix
//     removed /contact/candidate-phone-15125557319-details); the trunk check before #562 said "leak" for each of them too;
// (2) the random tokens the file page mints (session id, page token, signed link) are not a leak because their random part
//     happens to hold the phone's digits (gate architect shard 2 on #557 at 6632e62a).
// Tokens are minted by the real code, then digits planted, and each is checked against the production shape regex, so the
// cases are the real shapes, not look-alikes.
import assertNode from "node:assert/strict";
import { newSessionId, PAGE_TOKEN, pageTokenOf, SESSION_ID, sha256 } from "../../supabase/functions/_shared/file_session.ts";
import { mintFileToken } from "../../supabase/functions/_shared/file_link.ts";
import { phoneLeak, tokensOut } from "./phone-leak.ts";

const PHONE = "+15125557319", D10 = "5125557319", D7 = "5557319";
const SECRET = "s".repeat(40);
const LINK = /^v1\.([A-Za-z0-9_-]{10,1024})\.([A-Za-z0-9_-]{43})$/; // file_link.ts verifyFileToken's shape

// The check as it was on trunk before #562 (scenarios-file-websec-battery.ts), for the parity half.
const trunkCheck = (body: string, phone: string) => {
  const d = phone.replace(/[^0-9]/g, ""), d10 = d.slice(-10);
  return body.includes(phone) || body.includes(d10) || body.includes(d10.slice(3));
};

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const plant = (s: string, at: number, digits: string) => s.slice(0, at) + digits + s.slice(at + digits.length);

const READABLE: string[] = [
  `<a href="/contact/candidate-phone-15125557319-details">Contact</a>`,
  `<a href="/contact/candidate-phone-${D10}-details-and-everything-else-about-this-person">x</a>`,
  `<a href="https://example.com/people/adaline-pemberforth-mobile-${D7}-call-anytime-between-nine-and-five">x</a>`,
  `<a href="/u/${D10}">profile</a>`,
  `<a href="/x?phone=${D10}&next=/home">x</a>`,
  `<a href="/x?p=%2B1${D10}">x</a>`,
  `<a href="tel:${PHONE}">Call</a>`,
  `<a href="sms:${D10}">Text</a>`,
  `Your number is ${PHONE}.`,
  `call ${D10} now`,
  `ends in ${D7}`,
  `<td>${PHONE}</td>`,
  `{"phone":"${PHONE}"}`,
  `data-phone="${D10}"`,
  `<input name="phone" value="${D10}">`,
  `/files/${"a".repeat(40)}${D10}${"b".repeat(40)}`,
  `candidate_${D10}_${"x".repeat(60)}`,
  `${"Q".repeat(50)}${D7}${"Z".repeat(50)}`,
];

Deno.test("phone check: every readable phone form is still a leak, readable URLs of any length included (trunk agreed)", () => {
  for (const s of READABLE) {
    assertNode.equal(trunkCheck(s, PHONE), true, `trunk check: ${s}`);
    assertNode.equal(phoneLeak(s, PHONE), true, `shared check missed a readable leak: ${s}`);
    assertNode.equal(phoneLeak(s, PHONE, { last4: true }), true, `shared check (last4) missed: ${s}`);
  }
});

Deno.test("phone check: a token next to a phone, or a token-like run that is not exactly a minted shape, is still read", async () => {
  const id = newSessionId();
  const cases = [
    `<input name="t" value="${id}"> ${D10}`,
    `${id}${D10}`,                                  // hex goes on past 64: not the session id shape
    `${id.replace("fs1.", "fs2.")}`.slice(0, 4) + D7 + "0".repeat(57), // fs2. is not a minted prefix
    `fs1.${"0".repeat(20)}${D7}${"0".repeat(20)}`,  // 47 hex: too short to be a session id
    `xfs1.${plant(id.slice(4), 10, D7)}`,           // glued to a word: not a standalone token
    `v1.${D10}.short`,                              // not a signed-link shape
  ];
  for (const s of cases) assertNode.equal(phoneLeak(s, PHONE), true, `should still be read: ${s}`);
});

Deno.test("phone check: real minted tokens holding the phone's digits are not a leak; the trunk check said they were", async () => {
  const r = rng(20261106);
  let n = 0;
  for (let i = 0; i < 2000; i++) {
    const digits = [D7, D10, PHONE.slice(1)][i % 3];
    // session id: fs1. + 64 hex (the digits are hex characters)
    const sid = "fs1." + plant(newSessionId().slice(4), Math.floor(r() * (64 - digits.length + 1)), digits);
    assertNode.match(sid, SESSION_ID);
    // page token: fp1. + 64 hex, minted from a session id's hash
    const pt0 = await pageTokenOf(await sha256(newSessionId()), SECRET);
    assertNode.ok(pt0 && PAGE_TOKEN.test(pt0));
    const pt = "fp1." + plant(pt0!.slice(4), Math.floor(r() * (64 - digits.length + 1)), digits);
    assertNode.match(pt, PAGE_TOKEN);
    // signed link: v1.<b64url claims>.<43 b64url signature>; plant in the body or in the signature
    const lt0 = await mintFileToken({ secret: SECRET, userId: "u-" + i, list: "0123456789", now: 1_794_000_000_000 + i });
    const m = LINK.exec(lt0!)!;
    const lt = i % 2
      ? `v1.${plant(m[1], Math.floor(r() * (m[1].length - digits.length + 1)), digits)}.${m[2]}`
      : `v1.${m[1]}.${plant(m[2], Math.floor(r() * (43 - digits.length + 1)), digits)}`;
    assertNode.match(lt, LINK);
    const pages = [
      `<form><input name="t" value="${sid}"><input name="pt" value="${pt}"></form>`,
      `<a href="/file?t=${lt}">Open</a> <a href="/f/${lt}">Open</a>`,
      `{"session":"${sid}","link":"${lt}"}`,
      `Set-Cookie: fsid=${sid}; Path=/; HttpOnly`,
    ];
    for (const p of pages) {
      assertNode.equal(trunkCheck(p, PHONE), true, "the trunk check flagged a token (the flake this fixes)");
      assertNode.equal(phoneLeak(p, PHONE), false, `a minted token was read as a leak: ${p}`);
      assertNode.equal(phoneLeak(p, PHONE, { last4: true }), false, `a minted token was read as a leak (last 4): ${p}`);
      assertNode.ok(!tokensOut(p).includes(D7), "a planted token survived tokensOut");
      n++;
    }
  }
  assertNode.equal(n, 8000);
});

Deno.test("phone check: random readable pages with the phone planted anywhere are always a leak (seeded, 5,000)", () => {
  const r = rng(51255);
  const words = ["contact", "candidate", "phone", "details", "adaline", "pemberforth", "mobile", "call", "profile", "apply", "jobs", "view"];
  const forms = [PHONE, D10, D7, PHONE.slice(1)];
  for (let i = 0; i < 5000; i++) {
    const parts: string[] = [];
    const k = 2 + Math.floor(r() * 12);
    for (let j = 0; j < k; j++) parts.push(words[Math.floor(r() * words.length)]);
    parts.splice(Math.floor(r() * (k + 1)), 0, forms[i % forms.length]);
    const sep = ["-", "_", "/", "", "."][i % 5];
    const url = parts.join(sep);
    const page = [`<a href="/${url}">x</a>`, `${url}`, `<p>${parts.join(" ")}</p>`, `?q=${url}`][i % 4];
    assertNode.equal(phoneLeak(page, PHONE), true, `missed: ${page}`);
  }
});

Deno.test("phone check: the three file-page batteries use this one check, with no local copy left", async () => {
  for (const [f, last4] of [["scenarios-file-websec-battery.ts", false], ["scenarios-file-signin-battery.ts", true], ["scenarios-file-signin-r4-battery.ts", false]] as const) {
    const src = await Deno.readTextFile(new URL(`./${f}`, import.meta.url));
    assertNode.match(src, /import \{ phoneLeak as sharedPhoneLeak \} from "\.\/phone-leak\.ts";/, f);
    assertNode.doesNotMatch(src, /opaqueOut|body\.includes\(d10\)/, `${f} keeps its own copy`);
    assertNode.equal(/sharedPhoneLeak\(body, phone, \{ last4: true \}\)/.test(src), last4, `${f}: last-4 check ${last4 ? "kept" : "not added"}`);
  }
});
