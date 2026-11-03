/* Trainee: link Telegram (FEATURE 16, owner decision 2026-10-26).
   Telegram's "Link your Trainee account" button (login_url) opens /telegram-link with Telegram's signed fields in the
   query (id, first_name, last_name, username, photo_url, auth_date, hash). This page, signed in as the person, posts exactly
   those fields to trainee-telegram-link, which verifies Telegram's hash and the sign-in's age and links the chat once. The
   page decides nothing: it shows the server's own words, and posts only after the person confirms which Telegram account
   goes to which Trainee account (so a link someone else sends cannot attach their Telegram silently). "Unlink Telegram"
   posts { action: "unlink" }. */
(function (root, build) {
  const api = build();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TraineeTelegramLink = api;
})(globalThis, function () {
  'use strict';
  const FIELDS = ['id', 'first_name', 'last_name', 'username', 'photo_url', 'auth_date', 'hash'];
  // Only Telegram's own fields, as given; anything else in the address is left out.
  function authFrom(search) {
    const q = new URLSearchParams(search || '');
    const out = {};
    for (const k of FIELDS) if (q.has(k)) out[k] = q.get(k);
    return out.hash ? out : null;
  }
  async function call(o, body) {
    const token = await o.token();
    if (!token) return { outcome: 'signed_out', reply: 'Sign in to Trainee in this browser first, then tap "Link your Trainee account" in Telegram again.' };
    let r;
    try {
      r = await o.fetch(o.backend + '/functions/v1/trainee-telegram-link', { method: 'POST', headers: { 'content-type': 'application/json', apikey: o.anonKey, authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
    } catch (e) { return { outcome: 'failed', reply: 'Nothing was linked: Trainee could not be reached just now. Try again in a minute.' }; }
    const j = await r.json().catch(() => null);
    return j && typeof j.reply === 'string' ? j : { outcome: 'failed', reply: 'Nothing was linked: Trainee could not be reached just now. Try again in a minute.' };
  }
  const link = (o, search) => { const auth = authFrom(search); return auth ? call(o, { action: 'link', auth }) : Promise.resolve({ outcome: 'missing', reply: 'Open this page from the "Link your Trainee account" button in Telegram.' }); };
  const unlink = (o) => call(o, { action: 'unlink' });
  // What the person confirms before anything is posted (a link opened from someone else's message must not link silently):
  // the Telegram account the signed fields name, and the Trainee account this browser is signed in as.
  function question(auth, email) {
    if (!auth) return null;
    const name = [auth.first_name, auth.last_name].filter(Boolean).join(' ') || 'this Telegram account';
    const who = auth.username ? name + ' (@' + auth.username + ')' : name;
    return 'Link the Telegram account ' + who + ' to the Trainee account ' + (email || 'you are signed in as') + '? Only do this if that Telegram account is yours.';
  }
  return { authFrom, link, unlink, question, FIELDS };
});
