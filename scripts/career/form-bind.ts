// The fields a page shows (fnDiscoverFields in page-functions.cjs), bound into the questions the planner reads: one per
// name, a radio or checkbox group as one question with its options. Shared by the engine (scripts/apply.ts) and the
// browser extension (extension/lib/trainee-core.js), so both read a form the same way. Moved unchanged from apply.ts
// (WO-031). No Node, no Deno: it runs in a page.
import { classifyField } from "../../supabase/functions/_shared/career_apply.ts";

const fail = (code: string) => Object.assign(Error(code), { code });

export function bindFields(fields: any[]) {
  const groups = new Map<string, any[]>();
  for (const f of fields) {
    if (f.disabled || f.readOnly) continue;
    // A field is known by its name, or by its id where the page names nothing: Greenhouse's job-boards form gives every
    // field an id and no name, and Ashby's resume input has only an id (tests/fixtures/forms-ci). The id there is the
    // question's published key (first_name, question_9668368101, _systemfield_resume). Ashby's date picker has neither;
    // its container's data-field-path is the key.
    const name = f.name || f.id || f.fieldPath;
    if (!name) {
      if (f.required) throw fail("UNNAMED_REQUIRED_FIELD: " + f.label);
      continue;
    }
    groups.set(name, [...(groups.get(name) || []), f]);
  }
  const bindings: any = {}, schema: any[] = [];
  for (const [name, rows] of groups) {
    const f = rows[0], group = rows.length > 1 && rows.every((r) => ["radio", "checkbox"].includes(r.inputType));
    if (rows.length > 1 && !group) throw fail("AMBIGUOUS_FIELD_NAME: " + name);
    // A group the page gives no question of its own is named by all its choices ("Yes - I consent ... / No - I do not
    // consent ..."), never by its first option alone: the card reads "<question>: <the choice sent>", and a first option
    // read as the question made "Yes - I consent ...: No - I do not consent ..." (owner review, 2026-10-31).
    const label = group ? (f.groupLabel || rows.map((r) => r.label).filter(Boolean).join(" / ") || f.label) : f.label,
      type = f.tag === "select" ? "select" : f.inputType;
    // An option is chosen by its value; where the page gives its options no distinct values (Ashby's radios all read
    // "on"), the option's own text is its value, or every answer would land on the first option (WO-031).
    const values = rows.map((r) => r.optionValue ?? r.label);
    const distinct = new Set(values).size === values.length;
    const opts = group
      ? rows.map((r, i) => ({ label: r.label, value: distinct ? values[i] : r.label, selector: r.selector, ref: r.ref }))
      : f.options || [];
    const widget = /select__input/.test(f.cls || "") ? "react-select" : null;
    schema.push({
      name,
      label: label || name,
      type,
      required: rows.some((r) => r.required),
      options: opts.map((r: any) => ({ label: r.label, value: r.value })),
      // WO-052: a dropdown whose options load only when its menu opens is answered later, on the employer's own options
      // (chooseWidgetOption); the planner must not read it as a typed box.
      ...(widget ? { widget } : {}),
    });
    bindings[name] = {
      field_id: name,
      inputType: group
        ? (type === "radio" ? "radio_group" : "checkbox_group")
        : type === "file"
        ? "file"
        : type === "select"
        ? "select"
        : type === "checkbox"
        ? "checkbox"
        : "text",
      selector: f.selector,
      elementRefs: rows.map((r) => r.ref),
      options: opts,
      widget,
      profile_key: classifyField(label, type),
    };
  }
  return { bindings, schema };
}
