// WO-028: tailored resumes (career-resumes/<uid>/<sha256>.pdf, with the person's name and email) leave with the account
// (privacy policy: deleting your account deletes everything). Storage objects have no cascade from auth.users, so
// delete-account lists the folder and removes every file before the auth user is deleted, the way it handles the Vault.
// Check: node --test tests/career-resume-deletion.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
// The function and the steps it runs (moved to _shared/account_delete.ts in ERASE SCENARIOS ROUND 2, 2026-10-30).
const DELETE_ACCOUNT = fs.readFileSync(path.join(root, "supabase/functions/delete-account/index.ts"), "utf8") + "\n" +
  fs.readFileSync(path.join(root, "supabase/functions/_shared/account_delete.ts"), "utf8");
const MIGRATION = fs.readFileSync(path.join(root, "supabase/migrations/20261020130000_career_resume_tailoring.sql"), "utf8");

test("delete-account lists and removes the person's career-resumes folder before the auth user is deleted", () => {
  const list = DELETE_ACCOUNT.indexOf("/storage/v1/object/list/career-resumes");
  const remove = DELETE_ACCOUNT.indexOf("/storage/v1/object/career-resumes`");
  const authDelete = DELETE_ACCOUNT.indexOf("/auth/v1/admin/users/${uid}");
  assert.ok(list > 0, "it lists the bucket");
  assert.ok(remove > list, "then removes what it listed");
  assert.ok(authDelete > remove, "all before the auth user is deleted");
  assert.match(DELETE_ACCOUNT, /prefix: `\$\{uid\}\/`/, "only the person's own folder");
  assert.match(DELETE_ACCOUNT, /method: "DELETE",[\s\S]{0,200}body: JSON\.stringify\(\{ prefixes \}\)/, "by the Storage API's remove");
  assert.match(DELETE_ACCOUNT.slice(list - 400, remove + 400), /Bearer \$\{SERVICE_KEY\}/, "with the service key");
});

test("the bucket it empties is the one tailor_resume writes", () => {
  assert.match(MIGRATION, /values \('career-resumes', 'career-resumes', false,/);
  const tailor = fs.readFileSync(path.join(root, "supabase/functions/_shared/career_tailor.ts"), "utf8");
  assert.match(tailor, /export const RESUME_BUCKET = "career-resumes";/);
  assert.match(tailor, /return `\$\{userId\}\/\$\{sha256\}\.pdf`;/);
});
