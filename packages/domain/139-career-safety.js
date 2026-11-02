/* Career safety & honesty guards (T-80 kill switch, T-82 distress protocol, OUTE-007/008 decided caps +
   suppression, Doc 1 §9 / Doc 2 §5.3 refusals, truthful AI-use answers). Pure, no I/O, UMD like the
   other domain modules. These are the rails that must REFUSE well: a burst send, a fake referral, and
   taking an assessment for the user are never executed — each refusal names the why and offers the
   honest alternative. Suppression is severity-1: once a person opts out, no code path in this module
   lets them back into a send list. The kill switch halts every queue and resolves any in-flight item
   to a definite state — a send is either provider-confirmed sent, or it is not sent; never half-sent. */
const CareerSafety = (() => {
  const DAILY_START = 15, DAILY_CEILING = 30; // decided caps (owner, 2026-10-12): start 10–15/day, ceiling 30, users cannot raise

  // ---------- Suppression (OUTE-008): per-user + shared, forever ----------
  const keyOf = (p) => String((p && (p.email || p.name)) || "").trim().toLowerCase();
  function createSuppressionStore(seed) {
    const store = { records: [] };
    for (const r of (seed && seed.records) || []) store.records.push({ key: keyOf(r), name: r.name || null, email: r.email || null, reason: r.reason || "opt_out", at: r.at || null, scope: r.scope || "per_user" });
    return store;
  }
  function suppress(store, person, opts) {
    const o = opts || {}, key = keyOf(person);
    if (!key) return { ok: false, code: "person_required" };
    if (store.records.some((r) => r.key === key)) return { ok: true, already: true, key };
    const rec = { key, name: person.name || null, email: person.email || null, reason: o.reason || "opt_out", at: o.at || null, scope: o.scope || "per_user" };
    store.records.push(rec);
    return { ok: true, already: false, record: rec };
  }
  const isSuppressed = (store, person) => store.records.some((r) => r.key === keyOf(person));
  // Filter a candidate/send list: suppressed people come OUT, with the removal proven in the result.
  function applySuppression(store, list) {
    const kept = [], removed = [];
    for (const p of list || []) (isSuppressed(store, p) ? removed : kept).push(p);
    return { kept, removed, removed_count: removed.length, kept_count: kept.length, honored_100: removed.every((p) => isSuppressed(store, p)) && kept.every((p) => !isSuppressed(store, p)) };
  }
  // Mid-campaign opt-out: remove the person from every not-yet-sent queue entry; already-sent mail is history.
  function forceOptOut(store, campaign, person, opts) {
    const sup = suppress(store, person, opts);
    const before = (campaign.queue || []).length;
    campaign.queue = (campaign.queue || []).filter((q) => keyOf(q) !== keyOf(person));
    return { suppressed: sup, removed_from_queue: before - campaign.queue.length, queue_remaining: campaign.queue.length, person: keyOf(person) };
  }

  // ---------- Burst refusal + the safe schedule (OUTE-007) ----------
  function sendSchedule(total) {
    const days = []; let remaining = total, cap = DAILY_START, day = 0;
    while (remaining > 0 && day < 120) {
      day++;
      const today = Math.min(cap, remaining);
      days.push({ day, cap, sends: today });
      remaining -= today;
      if (day % 2 === 0) cap = Math.min(DAILY_CEILING, cap + 5); // ramp +5 per 2 days, ceiling decided
    }
    return { days, total_days: days.length, weeks: Math.ceil(days.length / 7), total };
  }
  function planSendRequest(input) {
    const o = input || {}, total = Number(o.total || 0), today = Number(o.requested_today || 0);
    if (today > DAILY_CEILING) {
      const sched = sendSchedule(total || today);
      return { ok: false, refused: true, code: "burst_refused", ceiling: DAILY_CEILING,
        text: `I won't send ${today} today — the cap is ${DAILY_CEILING}/day and it can't be talked up: blasting burns your mailbox's reputation and gets the account flagged. The safe schedule for ${sched.total} sends is about ${sched.total_days} days (~${sched.weeks} weeks) starting at ${DAILY_START}/day and ramping to ${DAILY_CEILING}/day. One approval starts it.`,
        schedule: sched };
    }
    return { ok: true, refused: false, today, ceiling: DAILY_CEILING };
  }

  // ---------- Fake-referral guard (Doc 1 §9) ----------
  // A referral claim may only be used when a stored fact supports it. profileFacts: [{id, text}].
  function referralClaimCheck(input) {
    const o = input || {}, claim = String(o.claim || "");
    const m = claim.match(/(?:told me to reach out|referred me|sent me your way|recommended I (?:contact|reach out))/i);
    if (!m) return { ok: true, claim_found: false };
    const facts = o.profileFacts || [];
    const supported = facts.some((f) => /referr|told (?:me|him|her) to reach out|introduction|intro from/i.test(String(f.text || "")) && (!o.claimed_by || String(f.text || "").toLowerCase().includes(String(o.claimed_by).toLowerCase().split(" ")[0])));
    if (supported) return { ok: true, claim_found: true, supported: true };
    const warm = (o.trueAngles || [])[0] || null;
    return { ok: false, refused: true, code: "fake_referral_refused", supported: false,
      text: `I can't say ${o.claimed_by || "someone"} told you to reach out — nothing in your profile or connections supports that, and a fake referral torches trust the moment it's checked.${warm ? ` The true warm angle you do have: ${warm}. Want the draft built on that instead?` : ""}`,
      true_angle: warm };
  }

  // ---------- Assessment refusal (Doc 2 §5.3): never taken for the user ----------
  function assessmentRequest(input) {
    const o = input || {};
    return { ok: false, refused: true, code: "assessment_not_taken",
      text: `I won't take your ${o.assessment || "assessment"} for you — that's the employer's test of you, and a mismatch between it and your interviews ends candidacies. What I will do: schedule it, remind you, and run prep — practice problems at the same difficulty, timed, with feedback on your own attempts.`,
      prep_offered: ["timed practice set at the assessment's difficulty", "review of your own attempted solutions", "scheduling + reminder so it never sneaks up"] };
  }

  // ---------- Truthful AI-use answer (Doc 2, employer AI rules) ----------
  function aiUseAnswer(input) {
    const o = input || {}, company = o.company || "the company";
    if (o.company_bans_ai_text) {
      return { truthful: true, path: "outline_only",
        draft: `AI tools helped me organize my materials, and I wrote the submitted text myself, as your policy asks. Every fact in my application is mine and I can speak to all of it.`,
        note: `${company} bans AI-written submission text, so the application itself followed the outline-only path; this answer says exactly that.` };
    }
    return { truthful: true, path: "ai_assisted_disclosed",
      draft: `Yes — I used an AI assistant to help tailor and proofread my application materials. The experience, projects, and facts are entirely mine, everything was reviewed by me, and I'm happy to walk through any of it in detail.`,
      note: "The answer discloses the AI help that actually happened (tailoring/proofreading) and claims nothing that did not." };
  }

  // ---------- Distress detector: THE one list (#354 safety follow-up, 2026-11-01) ----------
  // Every path reads this: the trust turn (supabase/functions/_shared/career_trust_turn.ts), 125's request screen
  // (respondToRequest), this module's distress protocol and the router's first check (142 handleChat / dispatchChat).
  // Four separate lists each missed what another caught ("kms", "i took too many pills", "i have a plan to end it").
  //
  // POLICY. A false alarm costs one kind check-in; a miss can cost a life. So a message that MIGHT be about ending one's
  // life or self-harm gets the check-in, hyperbole included ("i'd kill myself if i bombed it", "i'm not suicidal, just
  // tired"). Only idioms that are plainly about work or about something else stay with the router, and each is named
  // below (BENIGN, or a pattern's own guard): "this job is killing me", "kill it in the interview", "career suicide",
  // "my career is dead in the water", "i'll die on this hill", "12 kms from the office", "end it with a strong closing
  // line", "take my life in a new direction". Frustration without self-harm words ("this market is brutal", "i'm a
  // failure") is not a crisis here: 125's own support line answers the second.
  //
  // This list is the deterministic layer. In agent-chat a second layer runs beside it on every inbound message: OpenAI's
  // moderation endpoint (self-harm, self-harm/intent, self-harm/instructions; supabase/functions/_shared/career_crisis_screen.ts).
  // Either layer flagging gives the crisis reply; a moderation error or timeout leaves this list's answer, never a block.
  // Re-review of #354 (2026-11-01) widened it: method and lethality questions, any overdose or count of pills (named
  // drugs too), "off my balcony", rope and noose, a weapon on oneself, cutting and burning, worthlessness ("don't deserve
  // to live"), not existing or not waking up, "time to end it", and core Spanish, French and German phrases.
  //
  // How it reads: lower case, curly quotes straightened, apostrophes dropped (dont / don't, im / i'm read the same),
  // "2" between words read as "to"; the message is split into clauses at . ! ? , ; : and new lines, the benign idioms
  // are cut out of each clause, and each clause is tested on its own (so "$" below means the end of a clause).
  const BENIGN = [
    /\b(?:career|professional|social|political|commercial|financial|resume) suicide\b/g,
    /\bsuicide (?:prevention|squad)\b/g,
    /\b\d+(?:\.\d+)? ?kms\b/g,                                        // a distance
    /\bdie on (?:this|that|the) hill\b/g,
    /\b(?:if you |if someone |if somebody )?(?:put|had|held) a gun to my head\b/g,   // "gun to my head, i'd pick stripe"
    /\bgun to my head i(?:d| would)\b/g,
    /\blearn(?:ing|ed)? the ropes\b/g, /\bpoint of life insurance\b/g,
  ];
  // Pills and drugs as a person names them (a count of three or more of any of them, or a bottle, is an overdose's words).
  const DRUG = String.raw`(?:sleeping |sleep |pain )?(?:pills?|tablets?|meds|medication|medicine|painkillers?|tylenol|acetaminophen|paracetamol|advil|ibuprofen|aspirin|aleve|motrin|xanax|valium|klonopin|benadryl|ambien|melatonin|oxy\w*|percocet|vicodin|codeine|morphine|fentanyl|insulin|antidepressants?|sertraline|zoloft|prozac|lexapro|lithium|adderall|heroin)`;
  const MANY = String.raw`(?:(?:like|about|around|maybe|over|almost|at least|nearly|roughly|probably) )?(?:too many|too much|a bunch of|a lot of|all (?:of )?(?:my|the)|a whole (?:bottle|pack|box|strip) of|the whole (?:bottle|pack|box|strip) of|a (?:bottle|handful|fistful) of|(?:my|the) (?:whole )?bottle of|so many|lots of|extra|[3-9]|\d{2,}|three|four|five|six|seven|eight|nine|ten|twenty|thirty|fifty|a hundred)`;
  const SELF = String.raw`(?:my ?self|my ?slef|myslef|mself)`;
  // What may follow "take my life" / "end my life" in a crisis: nothing, a time, or the next clause's start.
  const AFTER = String.raw`(?=$| (?:tonight|today|now|soon|anymore|already|someday|eventually|and|because|cause|cuz|bc|lol|i|if|tbh|honestly|so|but|when|after|before)\b)`;
  const DISTRESS_PATTERNS = [
    /\bsu[iy]?c[iy]?d\w*/, /\bsuis?id\w*/,                              // suicide, suicidal, sucide, suicde, suiside
    /\bsewer ?slide\b/, /\bself ?delet\w*/, /\bun ?aliv\w*/,             // slang
    /\bkms+\b/, /\bk m s\b/,
    new RegExp(String.raw`\bkil+(?:l?ing|l?ed|s)? ?${SELF}`),           // kill myself, killing myself, kil my self, killmyself
    /(?:^|\b(?:just|please|pls|plz|someone|somebody|want (?:someone )?to|wish (?:someone|something) would|could someone)) kill me\b/,
    new RegExp(String.raw`\b(?:hurt|harm|cut|hang|shoot|drown|poison|starve|stab|suffocate|strangle)(?:t?ing|ed|s)? ${SELF}`),
    new RegExp(String.raw`\bburn(?:s|ed|t|ing)? ${SELF}(?! out\b)`),                   // "burn myself out" is work
    /\b(?:i|ive|i have|im|i am|been|started|start|keep|kept|back to|relapsed)(?: been| started)? (?:cutting|self harming|burning)(?: again)?(?: (?:lately|recently|tonight|today))?$/,
    /\bcutting (?:my )?(?:arms?|legs?|thighs?|skin|wrists?)\b/, /\brelapsed\b.{0,20}\b(?:cutting|self harm)/,
    /\bself ?(?:harm|injur|hurt)\w*/, /\b(?:slit|slitting|cut|cutting|slash\w*) (?:my )?wrists?\b/,
    new RegExp(String.raw`\b(?:end|ending|take|taking|took) my (?:own )?(?:life|lyfe|lyf)${AFTER}`),
    /\bend(?:ing)? (?:it all|everything|all of it)\b/, /\btime to end it(?: all)?$/,
    // "end it" as a plan; "end it with a closing line", "end it here" are an email's or a call's end.
    /\b(?:want|wanna|going|gonna|plan|planning|ready|thinking about|thought about|decided|deciding|try|trying|need|about|how) (?:to )?end(?:ing)? it(?: (?:all|tonight|today|now|soon|for good|already|forever))?$/,
    /\b(?:want|wish|need)(?:ed)? (?:it|it all|everything|this all|all of this|all this|my life) (?:all )?(?:to )?(?:just )?(?:end|be over)\b/,
    /\b(?:want|wish|need)(?:ed)? (?:it all|everything|all of this|all this) (?:to )?(?:just )?stop\b/,
    /\bmy life is (?:over|done|finished|pointless|meaningless|worthless)\b/,
    /\bhate (?:being alive|living|existing|my life|my existence)\b/,
    /\b(?:dont|do not|dont even) deserve (?:to )?(?:live|be alive|exist|be here|life)\b/, /\bdeserve to (?:die|be dead)\b/,
    /\bshould(?:nt| not) (?:be alive|exist|be here anymore|have been born)\b/, /\bshould(?:nt| not) be here$/,
    /\b(?:whats|what is|wheres|where is|is there|theres|there is) (?:the |even a |any |no )?point (?:of|in|to) (?:living|life|being alive|going on|existing|anything|any of (?:it|this))\b/,
    /\brather (?:be dead|die|not be alive|not exist|not wake up)\b/,
    /\bstop (?:existing|being alive)\b/, /\bstop living\b(?! (?:paycheck|like|in|with|at|for|on|off|under|out|from))/, /\bcease to exist\b/, /\b(?:want|wish|need)(?:ed)? (?:to )?(?:not exist|cease to exist|vanish forever|not be alive)\b/,
    /\b(?:hope|hopefully|wish|praying|pray) (?:that )?i (?:dont|never|do not|wont|will not) wake up\b/,
    /\b(?:life|living) (?:is|isnt|is not|aint) (?:not )?worth (?:it|living)\b/, /\bnot worth living\b/,
    /\b(?:want|wanna|wan|wnt|ready|deserve|should|wish i could) (?:to )?(?:just )?di+e+\b/,
    /\b(?:going|gonna) (?:to )?di+e+(?: (?:tonight|today|soon|anyway))?$/,
    /\bwish i (?:was|were|was just|were just) dead\b/,
    /\bwish i (?:wasnt|werent|was not|were not) (?:alive|here|around|born|living)\b/,
    /\bwish i (?:had never been|hadnt been|was never|were never|never was) born\b/,
    /\bbetter off (?:dead|without me|if i (?:was|were) (?:gone|dead)|if i (?:wasnt|werent) here)\b/,
    /\b(?:no ?one|nobody) would (?:miss me|notice if i (?:died|was gone|were gone)|care if i (?:died|was gone|were gone|disappeared|wasnt here))\b/,
    /\b(?:dont|do not|dnt|never) (?:want|wanna) (?:to )?(?:live|be alive|exist|wake up|be around anymore|go on|keep living)\b/,
    /\b(?:dont|do not|dnt) (?:want|wanna) (?:to )?be here(?: anymore)?$/,
    /\b(?:want|wanna|wish|need)(?: to)? (?:just )?not be (?:here|around)(?: anymore)?$/, /\b(?:want|wanna|wish|need)(?: to)? (?:just )?not be alive\b/,
    /\b(?:no|zero) (?:reason|point) (?:to|in|of) (?:live|living|going on|being alive|be alive|life)\b/, /\bnothing (?:left )?to live for\b/,
    /\bcant (?:keep living|live like this)\b/, /\bcant go on(?: (?:anymore|like this|living))?$/,
    /\b(?:tired|sick) of (?:living|being alive|life|existing)\b/, /\bdone (?:with life|living)\b/, /\bgive up on life\b/,
    /\b(?:sleep|go to sleep|fall asleep) and (?:never|not) wake up\b/, /\bnever wake up\b/, /\bhope i (?:dont|never|do not) wake up\b/,
    /\b(?:jump|jumping|jumped|throw myself|throwing myself|step|stepping|walk|walking|drive|driving) (?:off|off of|from|in front of|into) (?:a |the |some |my |our |this |that )?(?:\w+ )?(?:bridge|building|roof|rooftop|cliff|balcony|ledge|train|bus|car|traffic|truck|window|tower|overpass|parking garage)\b/,
    new RegExp(String.raw`\b(?:took|take|taken|taking|swallowed|swallow|swallowing|downed|down|ate|chugged|popped|pop|popping) ${MANY} (?:(?:my|his|her|their|the) (?:\w+ )?)?${DRUG}\b`),
    new RegExp(String.raw`\b(?:how many|how much)\b.{0,40}\b(?:to (?:die|kill (?:me|myself|someone|a person)|overdose|od)|(?:is|are|would be) (?:lethal|fatal|deadly|enough to die)|(?:would|will|does it take to|it takes to|to) (?:kill (?:me|you|someone|a person)|die))\b`),
    /\b(?:lethal|fatal|deadly) (?:dose|amount|overdose|combination|mix)\b/,
    /\b(?:painless|easiest|easy|quickest|quick|fastest|best|surest|least painful|most painless|simplest) (?:way|ways|method|methods) (?:to|of) (?:die|dying|kill myself|killing myself|end it|end my life|commit suicide)\b/,
    /\bways to (?:die|kill myself|end my life)\b/,
    /\b(?:want|wanna|going|gonna|plan|planning|thinking (?:about|of)|try|tried|trying|about|ready|decided) (?:to )?(?:od|oding|odd)\b/, /\b(?:i|just|almost|nearly) (?:odd|oded|od)(?: last night| tonight|$)/,
    new RegExp(String.raw`\bod(?:d|ing|ed)? on\b(?! (?:coffee|caffeine|sugar|meetings|work|info|information|netflix|tv|memes)\b)`),
    new RegExp(String.raw`\boverdos\w*\b(?! (?:of|on|from) (?!(?:my |the |some |all |a bottle of )?${DRUG})\w)`),          // never "overdose of coffee"
    /\b(?:tie|tied|tying|make|made|making|got|have|bought|buy) (?:a |the |my )?noose\b/, /\bnoose\b/,
    /\b(?:bought|buy|got|get|have|found) (?:a |some |the )?rope\b(?! access)/, /\brope\b.{0,30}\b(?:neck|hang|ceiling|beam|closet)\b/,
    /\b(?:gun|pistol|rifle|firearm|knife|blade|razor)\b.{0,60}\b(?:on myself|to my (?:head|wrist|throat|chest)|in my mouth|end it|kill myself|use it on me)\b/,
    /\buse (?:it|that|this|the gun|the knife) on myself\b/, /\bgun to my head\b/, /\bblow my (?:brains|head) out\b/, /\bdisappear forever\b/, /\bmy (?:last|final) goodbye\b/,
    // Re-review 2 (2026-11-01): method, intent and time cues.
    new RegExp(String.raw`\b(?:off|offing|offed) ${SELF}`),
    /\bbullet (?:in|into|through) my (?:head|brain|skull|mouth)\b/, /\bput a (?:bullet|gun) (?:in|to) my (?:head|brain|mouth)\b/,
    /\b(?:how|best way|ways?|easiest way|painless(?:ly)?|quickest way|fastest way|surest way) (?:to |do (?:i|you) )?(?:kill|hang|shoot|drown|poison|off|cut) (?:yourself|myself|urself|oneself|ur self|your self)\b/,
    /\b(?:going to|gonna|gon|will|plan to|planning to|about to|ready to|want to|wanna|im gonna|ima|imma) (?:jump|hang|rope)(?: (?:myself|tonight|today|now|soon|off something))*$/,
    /\b(?:going to|gonna|will|plan to|planning to|about to|ready to|want to|wanna|imma) end(?:ing)? things(?: (?:tonight|today|now|soon|for good|this week|this weekend|forever))?$/,
    /\b(?:end|ending) things (?:tonight|today|this week|this weekend|for good|forever)\b/, /\bi(?:ll| will) end things(?: soon| tonight)?$/,
    /\bhope i (?:die|dont wake up|never wake up|just die)\b(?! laughing| of laughter)/, /\bi (?:want|wanna) (?:to )?be dead\b/, /\b(?:just )?let me die\b/,
    /\b(?:pills?|meds|tablets) to end it\b/, /\bbought (?:pills|a gun|rope|a rope|a razor|razor blades) (?:to|so i can) (?:end|die|kill)/,
    /\b(?:bath|bathtub|tub|shower)\b.{0,30}\b(?:razor|blade|knife)\b/, /\b(?:razor|blade|knife)\b.{0,30}\b(?:bath|bathtub|tub|wrists?)\b/,
    /\bkills? (?:you|me|a person|someone|people)$/,
    // Italian, Portuguese, Dutch, Polish, Turkish, Indonesian, Tagalog, Hindi (romanized), Vietnamese, Swedish (Latin script, accents dropped).
    /\b(?:voglio|vorrei) (?:morire|uccidermi|ammazzarmi|farla finita)\b/, /\bmi voglio (?:uccidere|ammazzare)\b/, /\bnon voglio piu vivere\b/, /\bla faccio finita\b/,
    /\bquero (?:morrer|me matar|me suicidar|sumir para sempre)\b/, /\bnao quero mais viver\b/, /\bvou me (?:matar|suicidar)\b/,
    /\bik wil (?:dood|sterven|niet meer leven|zelfmoord)\b/, /\bzelfmoord\b/, /\bvan kant maken\b/,
    /\bchce (?:umrzec|sie zabic|zabic sie)\b/, /\bnie chce (?:juz )?zyc\b/, /\bsamoboj\w*/,
    /\bolmek istiyorum\b/, /\bkendimi oldur\w*/, /\bintihar\w*/, /\byasamak istemiyorum\b/,
    /\b(?:ingin|mau|pengen|pingin) mati\b/, /\bbunuh diri\b/, /\btidak mau hidup lagi\b/,
    /\b(?:mamatay|magpakamatay|magpapakamatay)\b/, /\bayoko nang mabuhay\b/,
    /\bmarna (?:chahta|chahti|hai|chahiye)\b/, /\b(?:khudkushi|aatmahatya|atmahatya)\b/, /\bjeena nahi\b/,
    /\bmuon (?:chet|tu tu)\b/, /\btu sat\b/,
    /\bvill (?:do|inte leva)\b/, /\bta livet av mig\b/, /\bsjalvmord\b/,
    // Spanish, French, German: the core phrases (accents are dropped before reading).
    /\b(?:quiero|quisiera|voy a|me voy a|ganas de) (?:morir(?:me)?|matarme|suicidarme|quitarme la vida|desaparecer para siempre)\b/,
    /\bme (?:quiero|voy a) (?:morir|matar|suicidar)\b/, /\bno quiero (?:vivir|seguir viviendo|estar viva?|despertar)\b/,
    /\b(?:acabar|terminar) con mi vida\b/, /\bno vale la pena vivir\b/,
    /\b(?:je veux|j ai envie de|envie de|je vais) (?:mourir|me tuer|me suicider|en finir|disparaitre)\b/, /\bje (?:ne )?veux plus vivre\b/, /\b(?:envie|veux) d ?en finir\b/,
    /\bmettre fin a mes jours\b/, /\bme (?:tuer|suicider)\b/,
    /\bich (?:will|mochte|moechte|werde) (?:sterben|mich umbringen|mich toten|mich toeten|nicht mehr leben)\b/, /\bmich umbringen\b/,
    /\bich bring(?:e)? mich um\b/, /\bselbstmord\w*/, /\bsuizid\w*/, /\bnicht mehr leben\b/, /\bmein leben beenden\b/,
  ];
  // Normalizing (re-review 2): a word mixing letters and digits is leetspeak (mys3lf, d13, k1ll; a pure number stays a
  // number, so "30 advil" keeps its count); "*" inside a word is a censored letter (k*ll, f***ing); a letter typed three
  // or more times is one (diiiie, suuuicidal); three or more single letters in a row are one word (k i l l); inserted
  // profanity and fillers are dropped (fucking, fr, ngl, deadass); common misspellings of "myself" are mended.
  const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", 9: "g" };
  const FILLER = /\b(?:fucking|fuckin|fking|fkn|fcking|freaking|frickin|effing|f+ing|goddamn|damn|bloody|literally|honestly|lowkey|highkey|ngl|fr|tbh|deadass|on god|ong|rn|lol|lmao)\b/g;
  function distressClauses(text) {
    const t = String(text == null ? "" : text).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\u00df/g, "ss").toLowerCase()
      .replace(/[‘’ʼ`´]/g, "'").replace(/'/g, "")
      .replace(/(\w)-(\w)/g, "$1 $2")
      .replace(/\b(?=[a-z0-9@$*]*[a-z])(?=[a-z0-9@$*]*[0-9@$])[a-z0-9@$*]+\b/g, (w) => w.replace(/[0-9]/g, (d) => LEET[d] ?? d).replace(/@/g, "a").replace(/\$/g, "s"))
      .replace(/\bk\*+ll/g, "kill").replace(/\bf\*+(?:ing|in|k)\b/g, "fucking").replace(/\*/g, "")
      .replace(/([a-z])\1{2,}/g, "$1");
    return t.split(/[.!?,;:\n]+/).map((c) => {
      let x = c.replace(/[^a-z0-9 ]+/g, " ").replace(/\b2\b/g, "to").replace(/\s+/g, " ").trim();
      x = x.replace(/\b(?:[a-z] ){2,}[a-z]\b/g, (m) => m.replace(/ /g, ""));
      x = x.replace(FILLER, " ").replace(/\bmy ?(?:slf|slef|sef|sefl|elf|selfe)\b/g, "myself").replace(/\s+/g, " ").trim();
      for (const b of BENIGN) x = x.replace(b, " ").replace(/\s+/g, " ").trim();
      return x;
    }).filter(Boolean);
  }
  // Scripts the normalizer cannot keep (Cyrillic, Japanese, Korean, Chinese, Arabic): read on the raw text.
  const NON_LATIN = [/умер(?:еть|ти)/, /покончить с собой/, /самоубийств/, /не хочу (?:больше )?жить/, /убить себя/,
    /死にたい/, /自殺/, /生きていたくない/, /消えたい/, /죽고 ?싶/, /자살/, /살고 ?싶지 ?않/, /想死/, /自杀/, /不想活/,
    /أموت/, /انتحار/, /أقتل نفسي/, /لا أريد أن أعيش/];
  // The message with its distress clauses taken out: what else the person asked, resumed after a check-in they answer
  // with "i'm fine" (142 resumeAfterCheckin). Empty when the whole message was the distress.
  function withoutDistress(text) {
    return String(text == null ? "" : text).split(/[.!?;\n]+|,\s*/).map((c) => c.trim()).filter((c) => c && !isDistress(c)).join(". ");
  }
  // A reply to the check-in saying they are fine or were misread.
  const FINE_RE = /^(?:(?:no|nah|nope|haha|lol|oh|sorry|honestly)[,! ]+)*(?:(?:i'?m|im|i am)\s+(?:fine|ok(?:ay)?|good|alright|all right|safe|not suicidal|okay now)|(?:you )?misread(?: me)?|false alarm|(?:i was |i'?m |im )?(?:just )?(?:venting|joking|kidding|exaggerating)|not like that|all good|i didn'?t mean it like that|it was (?:a )?(?:joke|figure of speech))\b/i;
  const isFineReply = (text) => FINE_RE.test(String(text == null ? "" : text).trim().replace(/[’‘]/g, "'"));
  function isDistress(text) {
    const raw = String(text == null ? "" : text).normalize("NFC").toLowerCase();
    if (NON_LATIN.some((p) => p.test(raw))) return true;
    return distressClauses(text).some((c) => DISTRESS_PATTERNS.some((p) => p.test(c)));
  }

  // ---------- Distress protocol (T-82) ----------
  function distressResponse(input) {
    const o = input || {}, text = String(o.text || "");
    const crisis = isDistress(text);
    const facts = o.profileFacts || [];
    const grounding = facts.length ? `Here is what is also true, from your own record: ${facts[0]}.` : "Here is what is also true: one rough stretch is not a verdict on you.";
    return {
      protocol: "distress", crisis,
      warmth_first: true, honesty_kept: true,
      text: crisis
        ? `I'm really glad you told me. If you're thinking about hurting yourself, you can call or text 988 (Suicide and Crisis Lifeline) any time in the US, or text HOME to 741741. I'm here, and everything else can wait. ${grounding}`
        : `That sounds genuinely rough, and I'm not going to pretend a pep talk fixes it. ${grounding} Not everything is working — some of it is a brutal market for interns right now, and that's real, not a character flaw. Let's make today tiny: one step, then stop.`,
      one_step: o.oneStep || "Send the one follow-up email that's already drafted — two minutes, then you're done for today.",
      resources: crisis ? ["988 Suicide and Crisis Lifeline (US): call or text 988", "Crisis Text Line: text HOME to 741741"] : [],
      plan_shrunk_to_one_step: true,
    };
  }

  // ---------- Kill switch (T-80): halt every queue, nothing half-sent ----------
  function createQueueState(seed) {
    return { campaigns: (seed && seed.campaigns) || [], applications: (seed && seed.applications) || [], followups: (seed && seed.followups) || [], halted: false, halted_at: null };
  }
  function stopEverything(state, opts) {
    const o = opts || {};
    const report = { sent_confirmed: 0, aborted_not_sent: 0, queued_halted: 0, by_queue: {} };
    const all = [["campaigns", state.campaigns || []], ["applications", state.applications || []], ["followups", state.followups || []]];
    for (const [name, items] of all) {
      const r = { sent_confirmed: 0, aborted_not_sent: 0, queued_halted: 0 };
      for (const it of items) {
        if (it.state === "sent") { it.halt_note = "already sent (provider-confirmed) — stays sent"; r.sent_confirmed++; }
        else if (it.state === "sending") { it.state = "aborted_not_sent"; it.halt_note = "was in-flight with no provider confirmation — resolved as NOT sent, never half-sent"; r.aborted_not_sent++; }
        else if (it.state === "queued" || it.state === "scheduled") { it.state = "halted"; r.queued_halted++; }
      }
      report.by_queue[name] = r;
      report.sent_confirmed += r.sent_confirmed; report.aborted_not_sent += r.aborted_not_sent; report.queued_halted += r.queued_halted;
    }
    state.halted = true; state.halted_at = o.at || null;
    const halfSent = [...(state.campaigns || []), ...(state.applications || []), ...(state.followups || [])].filter((i) => i.state === "sending");
    return { halted: true, report, half_sent_remaining: halfSent.length,
      text: `Stopped everything. ${report.sent_confirmed} already-sent item(s) stay sent (they were provider-confirmed). ${report.aborted_not_sent} in-flight item(s) had no confirmation and are marked NOT sent — nothing is half-sent. ${report.queued_halted} queued item(s) are halted and will not move until you say resume.` };
  }

  return { DAILY_START, DAILY_CEILING, keyOf, createSuppressionStore, suppress, isSuppressed, applySuppression, forceOptOut, sendSchedule, planSendRequest, referralClaimCheck, assessmentRequest, aiUseAnswer, isDistress, withoutDistress, isFineReply, distressResponse, createQueueState, stopEverything };
})();
if (typeof module !== "undefined" && module.exports) module.exports = CareerSafety;
