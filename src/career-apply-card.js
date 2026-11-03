/* Trainee apply card in the web chat (FEATURE E2E, 2026-10-26).
   The chat's card of prepared applications ("show my applications", agent-chat cardTurn; meta.intent
   'career_apply_card', meta.card_id) rendered under its message with an Approve and a Decline button. Before this, the web
   chat showed only the card's text, and a typed "yes" there approves nothing (it carries no reply id; the reply says to
   tap Approve), so a person on the web had no way to approve at all.
   What it reads, through the signed-in person's own row-level security: the card (career_apply_cards: its items, each
   with the payload hash it was shown with) and the prepared applications those items name (career_apply_prepared: the
   card lines and the payload hash). Every line shown comes from those rows, never from the reply text; an item whose
   prepared hash is no longer the hash the card carries is shown as changed and the card cannot be approved here.
   What it writes: one call, career_apply_card_answer_own(p_card, p_approve), with exactly the numbers the card shows
   (Approve) or none (Decline). The database approves each item only if its prepared payload still hashes to the
   card's hash and queues exactly that payload (career_apply_enqueue, approval = payload hash); nothing is sent here. */
(function (root, build) {
  const api = build();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TraineeApplyCard = api;
})(globalThis, function () {
  'use strict';
  const INTENT = 'career_apply_card';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const HASH = /^[0-9a-f]{64}$/;
  // The results career_apply_card_answer_for names, in the chat's own words (career_apply_cards.ts RESULT).
  const RESULT = Object.freeze({
    queued: 'approved; it is sent next, from your computer or, if you turned it on, the cloud',
    declined: 'not sent',
    daily_cap: 'not sent: today’s daily limit is already used',
    company_cooldown: 'not sent: you applied to them in the last 30 days',
    duplicate: 'not added again: this posting is already in your applications (sent, or approved and waiting to go); each posting goes at most once',
    stale: 'not sent: your details changed after it was prepared; prepare it again',
    changed: 'not sent: it changed after the card was shown',
    pace_unreadable: 'not sent: your saved daily pace could not be read',
    no_resume: 'not sent: there is no confirmed resume on file to send with it',
    refused: 'not sent: the queue refused it',
  });

  // The card a reply carries, or null.
  function cardIdOf(meta) {
    return meta && meta.intent === INTENT && typeof meta.card_id === 'string' && UUID.test(meta.card_id) ? meta.card_id : null;
  }

  // The card as the database holds it, checked against the prepared applications it names. ok: every item's prepared
  // payload still hashes to the hash the card carries; the lines are the prepared rows' own card lines.
  function verifyCard(card, prepared) {
    if (!card || !UUID.test(String(card.id || '')) || !Array.isArray(card.items) || !card.items.length) return { ok: false, why: 'missing' };
    const byId = new Map((prepared || []).map((p) => [p.id, p]));
    const items = [];
    for (const it of card.items) {
      const p = byId.get(it && it.prepared_id);
      if (!p || !Number.isInteger(it.n) || !HASH.test(String(it.payload_hash || ''))) return { ok: false, why: 'missing' };
      items.push({ n: it.n, company: String(p.company || ''), lines: (p.card_lines || []).map((l) => String(l)), payload_hash: it.payload_hash,
        changed: p.payload_hash !== it.payload_hash });
    }
    items.sort((a, b) => a.n - b.n);
    if (card.state !== 'open') return { ok: false, why: 'answered', items };
    if (items.some((i) => i.changed)) return { ok: false, why: 'changed', items };
    return { ok: true, items };
  }

  // The one call a tap makes: this card, and exactly its numbers (Approve) or none (Decline).
  function answerArgs(card, approve) {
    return { p_card: card.id, p_approve: approve ? card.items.map((i) => i.n).sort((a, b) => a - b) : [] };
  }

  function resultLines(results) {
    const list = Array.isArray(results) ? results : [];
    const queued = list.filter((r) => r && r.result === 'queued').length;
    return [queued ? queued + ' approved exactly as shown. Nothing has gone to an employer yet.' : 'Nothing was approved. Nothing went to an employer.',
      ...list.map((r) => r.n + '. ' + String(r.company || '').slice(0, 80) + ': ' + (RESULT[r.result] || RESULT.refused))];
  }

  // Reads the card and its prepared applications with the person's session (`from`: supabase-js's from), renders them
  // into `host` and wires the two buttons to `rpc`. `current()` false drops a late answer (the person moved on).
  async function mount(host, meta, o) {
    const cardId = cardIdOf(meta);
    if (!cardId || !host) return null;
    const doc = o.document || host.ownerDocument;
    const current = o.current || (() => true);
    const el = (tag, text, cls) => { const e = doc.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
    const box = el('section', undefined, 'mini career-apply-card');
    host.appendChild(box);
    const say = (text, alert) => { box.replaceChildren(el('p', text)); if (alert) box.setAttribute('role', 'alert'); };
    let card, prepared;
    try {
      const c = await o.from('career_apply_cards').select('id,items,state,shown_at').eq('id', cardId).maybeSingle();
      if (c.error) throw c.error;
      card = c.data;
      const ids = card && Array.isArray(card.items) ? card.items.map((i) => i.prepared_id) : [];
      const p = ids.length ? await o.from('career_apply_prepared').select('id,company,card_lines,payload_hash,state').in('id', ids) : { data: [] };
      if (p.error) throw p.error;
      prepared = p.data;
    } catch (e) {
      if (current()) say('This card could not be read. Nothing was approved.', true);
      return null;
    }
    if (!current()) return null;
    const v = verifyCard(card, prepared);
    if (!v.items) { say('This card could not be verified. Nothing was approved.', true); return v; }
    box.replaceChildren();
    for (const it of v.items) {
      const item = el('div', undefined, 'career-apply-item');
      item.appendChild(el('b', it.n + '. ' + (it.lines[0] || it.company)));
      for (const line of it.lines.slice(1)) item.appendChild(el('div', line));
      if (it.changed) item.appendChild(el('div', 'Changed since this card was shown: it cannot be approved from this card.'));
      box.appendChild(item);
    }
    if (!v.ok) {
      box.appendChild(el('p', v.why === 'answered' ? 'This card was already answered.' : 'Nothing on this card can be approved; say "show my applications" for a fresh card.'));
      return v;
    }
    const row = el('div', undefined, 'career-apply-actions');
    const approve = el('button', v.items.length === 1 ? 'Approve' : 'Approve all ' + v.items.length, 'primary');
    const decline = el('button', 'Decline', 'ghostbtn');
    approve.type = decline.type = 'button';
    row.append(approve, decline);
    box.appendChild(row);
    const answer = async (yes) => {
      approve.disabled = decline.disabled = true;
      try {
        const r = await o.rpc('career_apply_card_answer_own', answerArgs(card, yes));
        if (r.error) throw r.error;
        if (!current()) return;
        row.replaceWith(...resultLines(r.data).map((l) => el('p', l)));
      } catch (e) {
        if (!current()) return;
        const msg = String((e && e.message) || e);
        approve.disabled = decline.disabled = false;
        row.appendChild(el('p', /card_stale/.test(msg) ? 'This card was shown more than 10 minutes ago, so nothing was approved. Say "show my applications" for a fresh card.'
          : /card_answered/.test(msg) ? 'This card was already answered. Nothing more was sent.'
          : /card_expired/.test(msg) ? 'This card is more than a day old, so nothing was approved.'
          : 'Nothing was approved: the card could not be answered just now.'));
      }
    };
    approve.onclick = () => answer(true);
    decline.onclick = () => answer(false);
    return v;
  }

  return Object.freeze({ INTENT, RESULT, cardIdOf, verifyCard, answerArgs, resultLines, mount });
});
