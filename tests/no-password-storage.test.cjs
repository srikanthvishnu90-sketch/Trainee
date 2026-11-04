// No password storage (owner, 2026-10-11, decision 1, settled): "Passwords never sit in chat or in a database; the person
// logs in themselves through a live browser window, completes their own 2FA, and only the encrypted session persists."
// Read from the source. The finance edge functions that stored or typed credentials (exec-vault-store, agent-exec,
// manual-connect) and their checks were removed on 2026-10-28; what remains is the app's own rule.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

test('the app asks only for the sign-in email, and says why', () => {
  const t = read('src/upmore-app-template.html');
  const view = t.slice(t.indexOf('<div id="agentCredView"'), t.indexOf('<div id="agentRunView"'));
  assert.ok(!/type="password"|agentCredPass/.test(view));
  assert.ok(view.includes('Upmore never asks for or stores your password.'));
  assert.ok(!t.includes('agentCredPass'), 'no code path reads a password field');
  assert.ok(t.includes('body: { merchant_key: mkey, username: u, label: sub.merchant },'));
});
