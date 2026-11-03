// Test-only page widgets shared by the dry-run fixtures: a react-select-like combobox and a submit sink. Not an employer's code.
document.querySelectorAll("[data-combobox]").forEach((root) => {
  const input = root.querySelector("input[role=combobox]"), opts = JSON.parse(root.dataset.combobox);
  let menu = null;
  const close = () => { if (menu) { menu.remove(); menu = null; } };
  const open = (filter) => {
    close();
    menu = document.createElement("div"); menu.setAttribute("role", "listbox"); menu.className = "select__menu";
    opts.filter((o) => !filter || o.toLowerCase().includes(filter.toLowerCase())).forEach((o) => {
      const d = document.createElement("div"); d.setAttribute("role", "option"); d.textContent = o; d.style.cssText = "padding:6px 10px;cursor:pointer;background:#fff";
      d.addEventListener("click", () => {
        let v = root.querySelector(".select__single-value");
        if (!v) { v = document.createElement("div"); v.className = "select__single-value"; root.querySelector(".select__value-container").prepend(v); }
        v.textContent = o; input.value = ""; close();
      });
      menu.appendChild(d);
    });
    root.appendChild(menu);
  };
  input.addEventListener("click", () => open(""));
  input.addEventListener("focus", () => open(input.value));
  input.addEventListener("input", () => open(input.value));
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
});
document.querySelectorAll(".ashby-application-form-input-yesno").forEach((box) => box.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
  box.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
})));
const f = document.querySelector("form");
if (f) f.addEventListener("submit", (e) => { e.preventDefault(); fetch("/submit", { method: "POST", body: new FormData(e.target) }); });
// Static captures have their site script removed: an option clicked inside a react-select-like shell shows as the chosen value.
document.addEventListener("click", (e) => {
  const o = e.target.closest && e.target.closest("[role=option]");
  const shell = o && o.closest(".select-shell, .select__container");
  if (!shell || shell.hasAttribute("data-combobox")) return;
  const vc = shell.querySelector(".select__value-container");
  if (!vc) return;
  let v = vc.querySelector(".select__single-value");
  if (!v) { v = document.createElement("div"); v.className = "select__single-value"; vc.prepend(v); }
  v.textContent = (o.textContent || "").trim();
});
