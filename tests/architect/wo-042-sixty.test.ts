// WO-042 (60 reviewed applications in 30 minutes): the planner rules added from live run 4 on the 17 real pages
// (evals/apply/results/live-fill.json), each a wrong answer or a miss seen there. Contract:
// docs/architect/work-orders/WO-042-sixty-in-thirty.md.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { type Answer, type FormField, planBatch } from "../../supabase/functions/_shared/career_apply.ts";
import { chooseOption, placeQuery } from "../../supabase/functions/_shared/answer_options.ts";
import { chooseWidgetOption, formAnswersToKeep, MASKED } from "../../extension/src/apply_core.ts";
import CONTENT from "../../extension/content.js" with { type: "text" };
import DOM from "../../extension/src/dom.ts" with { type: "text" };
import BACKGROUND from "../../extension/background.js" with { type: "text" };
import GRADE from "../fixtures/extension/grade.cjs" with { type: "text" };

const fact = (value: string, id = "f-" + value): Answer => ({ value, factId: id });
const opts = (xs: string[]) => xs.map((l) => ({ label: l, value: l }));
const field = (name: string, label: string, options: string[] = [], type = "input_text"): FormField => ({ name, label, required: true, type, options: opts(options) });
const plan = (company: string, fields: FormField[], answers: Record<string, Answer>) =>
  planBatch({ userId: "u", postings: [{ job_id: "j", company, title: "", fields }], answers, saved: {}, log: [], now: Date.now() });
const filled = (company: string, fields: FormField[], answers: Record<string, Answer>) =>
  Object.fromEntries((plan(company, fields.map((f) => ({ ...f, required: false })), answers).ready[0]?.fields ?? []).map((p) => [p.name, p.value]));

const SPACEX = [
  "I have never worked for SpaceX, SpaceXAI, xAI, X, or Twitter",
  "I am a former SpaceX, SpaceXAI, xAI, X, or Twitter employee",
  "I am a current SpaceX employee",
];
Deno.test("WO-042/1 worked here before: a No covers only the companies checked; a former employer named in the question or its options is asked", () => {
  const q = field("q1", "SpaceX & SpaceXAI Employment History", SPACEX);
  assertEquals(filled("SpaceX", [q], { former_employers: fact("Example Analytics; Sample Retail") }).q1, SPACEX[0]);
  // The person once worked at Twitter: "never worked for ... Twitter" would be false, so nothing is filled.
  assertEquals(filled("SpaceX", [q], { former_employers: fact("Example Analytics; Twitter") }).q1, undefined);
  assertEquals(plan("SpaceX", [q], { former_employers: fact("Example Analytics; Twitter") }).needs.length, 1, "asked instead");
  // A former employer that is the company itself is a plain yes, as before.
  assertEquals(filled("Acme", [field("q2", "Have you worked for Acme before?", ["Yes", "No"])], { former_employers: fact("Acme Inc") }).q2, "Yes");
});

Deno.test("WO-042/2 a degree: synonyms are one answer, the one that says degree; different degrees or one in progress are not", () => {
  const anduril = ["Accelerated Master's", "Associates", "Associate's Degree", "Bachelors", "Bachelor's Degree", "Master's Degree", "MBA"];
  assertEquals(chooseOption("education_level", "bachelor", opts(anduril), "Degree"), "Bachelor's Degree");
  assertEquals(chooseOption("education_level", "bachelor", opts(["Bachelor of Arts", "Bachelor of Science", "Master's"]), "Degree"), null);
  assertEquals(chooseOption("education_level", "bachelor", opts(["Bachelor's Degree (in progress)", "Bachelor's Degree"]), "Degree"), "Bachelor's Degree");
  assertEquals(chooseOption("education_level", "bachelor", opts(["Bachelor's Degree (in progress)", "High School"]), "Degree"), null);
  assertEquals(chooseOption("education_level", "master", opts(["Master's Degree", "Masters", "Master of Business Administration (M.B.A.)"]), "Degree"), null);
});

Deno.test("WO-042/3 Greenhouse's education end date is the stated graduation date, only beside its school, only the first entry", () => {
  const edu = [field("school--0", "School"), field("end-month--0", "End date month"), field("end-year--0", "End date year")];
  const a = { graduation_date: fact("05/2022", "g1"), school: fact("Example State University") };
  const got = filled("Anduril", edu, a);
  assertEquals(got["end-year--0"], "2022");
  assertEquals(got["end-month--0"], "May");
  assertEquals(filled("Anduril", edu, { graduation_date: fact("2022-12") })["end-month--0"], "December");
  assertEquals(filled("Anduril", edu, { graduation_date: fact("May 2022") })["end-month--0"], "May");
  // Not an education block: an end date with no school beside it is a job's, never the graduation date.
  assertEquals(filled("Anduril", [field("end-year--0", "End date year")], a)["end-year--0"], undefined);
  assertEquals(filled("Anduril", [field("school--1", "School"), field("end-year--1", "End date year")], a)["end-year--1"], undefined);
  // Among the employer's own options the planner reads the month, with the whole form beside it.
  const months = ["January", "February", "March", "April", "May", "June"];
  assertEquals(filled("Anduril", [edu[0], field("end-month--0", "End date month", months, "multi_value_single_select"), edu[2]], a)["end-month--0"], "May");
  // FRS (frs-gh-widget): a widget clicks only an option the WO-102 contract would approve on a select. "May" is read out
  // of "05/2022", not the person's words, so the contract asks it on every path, and the widget no longer clicks it.
  const month = chooseWidgetOption({ userId: "u", jobId: "j", company: "Anduril", family: "greenhouse", field: edu[1],
    labels: months, answers: a, saved: {}, now: Date.now(), form: edu });
  assertEquals(month, null);
  const alone = chooseWidgetOption({ userId: "u", jobId: "j", company: "Anduril", family: "greenhouse", field: edu[1],
    labels: ["January", "May"], answers: a, saved: {}, now: Date.now() });
  assertEquals(alone, null, "without the form, no school beside it: not filled");
});

Deno.test("WO-042/4 a place search: the city or the state's name is typed; a state is picked from places that name it", () => {
  assertEquals(placeQuery("Chicago, IL"), "Chicago");
  assertEquals(placeQuery("IL"), "Illinois");
  assertEquals(placeQuery("NY"), "New York");
  const places = ["Illinois, United States", "Illinois City, Illinois, United States", "Chicago, Illinois, United States"];
  assertEquals(chooseOption("state", "IL", opts(places), "Which state do you live in?"), "Illinois, United States");
  assertEquals(chooseOption("location", "Chicago, IL", opts(["North Chicago, Illinois, United States", ...places]), "Location"), "Chicago, Illinois, United States");
});

Deno.test("WO-042/5 nothing that happens while Trainee fills counts as the person's edit, and no card goes out mid-fill", () => {
  // Every trusted input, change and widget mousedown goes through personEdit, which ignores everything while busy.
  const edit = CONTENT.slice(CONTENT.indexOf("const personEdit"), CONTENT.indexOf("const personEdit") + 300);
  assert(/if \(busy\) return;/.test(edit), "personEdit ignores events while Trainee fills");
  assert(/document\.addEventListener\(t, \(e\) => \{[\s\S]{0,200}personEdit\(/.test(CONTENT), "input/change go through personEdit");
  assert(/addEventListener\("mousedown"[\s\S]{0,250}personEdit\(n\)/.test(CONTENT), "widget mousedown goes through personEdit");
  assert(/setTimeout\(\(\) => \(busy \? undefined : refresh\(\)/.test(CONTENT), "a scheduled refresh never runs mid-fill");
  // The queue's record before the card says done.
  const q = BACKGROUND.indexOf("await queueAfter(tabId,"), c = BACKGROUND.indexOf('return await withCards(tabId, "finish:"');
  assert(q > 0 && c > 0 && q < c, "queue updated before the done card");
});

Deno.test("WO-042/6 the grader: a place picked from the employer's list is the persona's place; another city is not", async () => {
  const mod = { exports: {} as any };
  new Function("module", "exports", "require", GRADE)(mod, mod.exports, () => ({}));
  const { same, yn } = mod.exports;
  assert(same("Chicago, Illinois, United States", "Chicago, IL"));
  assert(same("Illinois, United States", "IL"));
  assert(!same("North Chicago, Illinois, United States", "Chicago, IL"));
  assert(!same("Chicago, Indiana, United States", "Chicago, IL"));
  assert(same("I have never worked for SpaceX, SpaceXAI, xAI, X, or Twitter", "No"), "an option that says no meets the key's No");
  assert(!same("I am a former SpaceX, SpaceXAI, xAI, X, or Twitter employee", "No"));
  assertEquals(yn("I have never worked for SpaceX"), "no");
  assertEquals(yn("I am a former SpaceX employee"), null);
});

Deno.test("WO-042/7 a place search waits for the page's load, types once and awaits a slow first lookup (Lever, live runs 5 and 6)", () => {
  const body = DOM.slice(DOM.indexOf("async function drivePlace"), DOM.indexOf("export interface Resume"));
  assert(/readyState === "complete"/.test(body), "the load is awaited before typing");
  assert((body.match(/\btype\(\);/g) || []).length === 1, "typed once: a second typing cancels a slow first lookup");
  assert(/until\(listed, 8000\)/.test(body), "the list is awaited up to 8 s");
  assert(/press\(hit\)/.test(body) && /if \(!hit\)/.test(body), "a place is clicked only when the planner names one");
});

Deno.test("WO-042/8 Lever's place search gets the city key by key: its lookup starts only on a keydown (live run 10)", async () => {
  const body = DOM.slice(DOM.indexOf("async function drivePlace"), DOM.indexOf("export interface Resume"));
  assert(/contains\("location-input"\)/.test(body), "Lever's input is told apart");
  assert(/if \(keys\) return typeKeys\(el, city\)/.test(body), "Lever's input is typed key by key");
  const keys = DOM.slice(DOM.indexOf("function typeKeys"), DOM.indexOf("function closeMenu"));
  assert(/for \(const ch of text\)[\s\S]{0,200}"keydown"[\s\S]{0,300}"keyup"/.test(keys), "a keydown and a keyup per character");
  // The offline stand-in follows Lever's own rules, so a driver without the keydown fails offline as it did live.
  const WORLD = await Deno.readTextFile(new URL("../fixtures/extension/world.cjs", import.meta.url));
  assert(/addEventListener\("keydown"[\s\S]{0,900}\}, 500\)/.test(WORLD), "the stand-in looks up 500 ms after a keydown");
  const lever = WORLD.slice(WORLD.indexOf("function wireLever"), WORLD.indexOf("function wire(input)"));
  assert(/addEventListener\("input", function \(\) \{ box\.style\.display = "flex"; \}\)/.test(lever), "input only shows the dropdown");
});

Deno.test("WO-042/9 a page that loads before the click's message is still read; a late 'submitting' never undoes a done card", () => {
  // CI on #62 (2cb555b7, 5f686b78, 192b27b3): Lever's thank-you page finished loading before "clicked" landed, so the
  // load event passed the tab by and the card stayed at "submitting".
  const clicked = BACKGROUND.slice(BACKGROUND.indexOf('case "clicked"'), BACKGROUND.indexOf('case "outcome"'));
  assert(/tab\?\.status === "complete"/.test(clicked) && /__traineeClicked === true/.test(clicked) && /afterNavigation\(tabId\)/.test(clicked),
    "the clicked handler reads a page that already loaded without the clicking page's mark");
  assert(/globalThis\.__traineeClicked = true;[^\n]*\n\s*button\.click\(\);/.test(CONTENT), "the clicking page marks itself just before the click");
  assert(/patch\.status === "submitting" && prev\?\.status === "done"\) return null/.test(BACKGROUND), "submitting never lands on done");
  assert(/addListener\(\(tabId, info\) => \{\s*if \(info\.status === "complete"\) afterNavigation\(tabId\);/.test(BACKGROUND), "the load event uses the same reader");
});

Deno.test("WO-042/10 Greenhouse's location search is typed key by key; a value the page drops while it hydrates is set again", () => {
  // Live run 12: one input event loaded the places but left react-select's menuIsOpen false; key by key opened it with
  // all 10 places, as trusted typing did.
  const widget = DOM.slice(DOM.indexOf("async function driveWidget"), DOM.indexOf("export function isPlaceSearch"));
  assert(/else typeKeys\(el, placeQuery\(wanted\)\)/.test(widget), "an untoggled search gets the place key by key");
  // Live run 12: Anduril's First Name was empty 20 ms after it was set; it is set once more after the rest.
  assert(/else if \(ok && !listed && b\.inputType !== "file"\) dropped\.push\(p\)/.test(CONTENT), "a dropped plain field is kept for later");
  assert(/for \(const p of dropped\)[\s\S]{0,120}edited\.has\(p\.name\)[\s\S]{0,80}(?:D\.fill|prefillWrite)\(b, p\.value, resume\)/.test(CONTENT), "and set again unless the person edited it");
  // architect amendment (2026-11-10, #703 D-MS-1): every extension write goes through prefillWrite (no typed value before
  // the tap); the refill of a dropped value is the same call through that guard.
});

Deno.test("WO-042/11 ask once, from the form: only the person's own answer to a question this posting raised is kept, under the text path's key", () => {
  // Session run 4: 50 of 60 cards needed the person, the same questions typed again at every company; only texted answers
  // were kept. A form answer travels exactly as far as a texted one (answerKey), and nothing else on the form is kept.
  const needs = [
    { label: "How did you hear about us?", type: "input_text", options: [] },
    { label: "Why do you want to work at Example Co?", type: "textarea", options: [] },
    { label: "Social Security Number", type: "input_text", options: [] },
    { label: "Portfolio", type: "input_file", options: [] },
    { label: "Pronouns", type: "input_text", options: [] },
    { label: "Website", type: "input_text", options: [] },
    { label: "Anything else we should know?", type: "input_text", options: [] },
    { label: "Do you have any relatives working here?", type: "input_text", options: [] },
  ];
  const fields = [
    { name: "q1", label: "How did you  hear about us?", value: " LinkedIn ", source: "you" },
    { name: "q2", label: "Why do you want to work at Example Co?", value: "Because of the team.", source: "you" },
    { name: "q3", label: "Social Security Number", value: MASKED, source: "you" },
    { name: "q4", label: "Portfolio", value: "work.pdf", source: "you" },
    { name: "q5", label: "Pronouns", value: "they/them", source: "page" },
    { name: "fixed:q6", label: "Website", value: "https://example.test", source: "you" },
    { name: "q7", label: "Email", value: "me@example.test", source: "you" },
    { name: "q8", label: "Anything else we should know?", value: "I have used Example Co's app for years.", source: "you" },
    { name: "q9", label: "Do you have any relatives working here?", value: "No", source: "you" },
  ];
  const kept = formAnswersToKeep({ jobId: "job-1", company: "Example Co", needs, fields, answers: {}, answered: new Set() });
  assertEquals(kept.posting, "job-1");
  assertEquals(kept.answers.map((a) => [a.label, a.answer]), [
    ["How did you hear about us?", "LinkedIn"],
    ["Why do you want to work at Example Co?", "Because of the team."],
    ["Do you have any relatives working here?", "No"],
  ]);
  const [heard, essay, relatives] = kept.answers;
  assertEquals(heard.key, "fact:how_heard", "a channel is true of every employer");
  assert(/^job:[0-9a-f]{16}$/.test(essay.key), "an essay stays with its posting");
  assert(/^job:[0-9a-f]{16}$/.test(relatives.key), "relatives at this employer is about this employer only");
  // An answer about this employer never travels: a how-heard that names no channel, or one naming the company.
  const friend = formAnswersToKeep({ jobId: "job-2", company: "Example Co", needs: needs.slice(0, 1), answers: {}, answered: new Set(),
    fields: [{ name: "q1", label: "How did you hear about us?", value: "A friend here told me", source: "you" }] });
  assertEquals(friend.answers, []);
  // Session run 5: an acknowledgment ticked for one employer and a veteran-status answer were filled again at the next.
  // An agreement and a self-identification answer never leave their posting.
  const stays = [
    { label: "I understand that next steps will be sent via email and I have marked the address", type: "input_checkbox" },
    { label: "Are you a transitioning service member?", type: "input_text" },
    { label: "What is your gender?", type: "input_text" },
    { label: "I acknowledge the privacy notice", type: "input_checkbox" },
  ];
  const sensitive = formAnswersToKeep({ jobId: "job-3", company: "Example Co", answers: {}, answered: new Set(),
    needs: stays.map((x) => ({ ...x, options: [] })),
    fields: stays.map((x, i) => ({ name: "s" + i, label: x.label, value: "Yes", source: "you" })) });
  assertEquals(sensitive.answers, [], "agreements and self-identification stay with their posting");
  // Kept only after the page confirmed the send, and a failure to keep never touches the outcome.
  const finish = BACKGROUND.slice(BACKGROUND.indexOf("career_apply_questions_answer_from_form_own") - 400, BACKGROUND.indexOf("career_apply_questions_answer_from_form_own") + 300);
  assert(/observation && p\.form_answers/.test(finish) && /try \{/.test(finish) && /catch/.test(finish), "kept on a confirmed send, best effort");
});

Deno.test("WO-042/12 a searched long list (a school) reads the filtered list or the page's 'no options', never a fixed sleep", () => {
  // Live run 14: a school not on Greenhouse's list cost 2.5 s on each of 3 forms (a 400 ms sleep, then 2 s waiting for
  // options that could not come). The wait now ends on the filtered list or react-select's own no-options notice.
  const widget = DOM.slice(DOM.indexOf("async function driveWidget"), DOM.indexOf("export function isPlaceSearch"));
  assert(!/await sleep\(/.test(widget), "no fixed sleep in the widget driver");
  assert(/menu-notice--no-options/.test(widget), "the page's 'no options' ends the wait");
  assert(/!== before\) return now/.test(widget), "the list from before the typing is never read as the filtered one");
  // Live run 16: the notice was read page-wide, and the School menu's notice ended Discipline's search: it is read inside
  // this select only.
  // Live run 17: on Greenhouse the menu is not under the control's parent; it is found through the input's own listbox.
  assert(/getAttribute\("aria-controls"\)/.test(widget) && /\(__\|-\)menu\$/.test(widget) && /own\?\.querySelector\("\[class\*='menu-notice--no-options'\]"\)/.test(widget), "this select's own notice only, through its listbox");
  // Live run 18: Discipline shows "no options" for its own list before its remote matches arrive; the notice counts only
  // from a second after the typing.
  assert(/menu-notice--no-options'\]"\) && Date\.now\(\) - typedAt > 1000\) return \[\]/.test(widget), "a no-options notice counts only after 1 s");
  // The offline stand-in's lists never filter: an unchanged list with no loading notice is final after 600 ms, not 2.4 s.
  assert(/Date\.now\(\) - typedAt > 600 && !own\?\.querySelector\("\[class\*='menu-notice--loading'\]"\)/.test(widget), "an unchanged list is final after 600 ms");
});
