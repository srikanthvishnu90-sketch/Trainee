// Where the extension signs in and records applications. The Supabase URL and anon key are the app's own public values
// (src/upmore-app-template.html: UPMORE_BACKEND_URL, UPMORE_ANON_KEY); the anon key is public by design and every read
// and write goes through the person's own session and row-level security. A person may point the extension elsewhere
// in the panel's settings (kept in chrome.storage.local); no secret is ever configured here.
globalThis.TRAINEE_DEFAULTS = {
  supabaseUrl: "https://mrwngntwmnaqrqhupvlt.supabase.co",
  anonKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1yd25nbnR3bW5hcXJxaHVwdmx0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAwMzk1MDksImV4cCI6MjEwNTYxNTUwOX0.BZKqFIUdjLU_eLuTQecxsHdhIQu1GprTbZmkAPO6p88",
  appUrl: "https://upmore-topaz.vercel.app",
  // Person-submits mode (first real submissions, plan v2): when true, the extension fills the form, shows the card and
  // runs every check up to the click, then presses nothing: the person reads the filled page and presses the site's own
  // Submit. Off by default; switching it on is the owner's call. Fixed here, never by storage (a page can write storage).
  personSubmits: false,
  // Agent submits (WO-101): the person approves a batch up front, of the exact answers per posting, and Trainee sends each
  // posting itself with the site's own Submit only when the page holds exactly what they approved; a receipt after each;
  // "Stop applying" stops it. The owner's own switch (CAREER_AGENT_SUBMIT) must also be on in the database. Off by
  // default; switching it on is the owner's call. Fixed here, never by storage.
  agentSubmits: false,
  // How many tabs the agent sends on at once (each its own window). 1 by default; at most 3. More than one is untested on a
  // real desktop, where Chrome may throttle a hidden or minimized window (docs/apply/FIFTY-IN-THIRTY.md, wo/frs-fifty).
  agentTabs: 1,
  // D-MS-1 (x-audit, coordinator ruling 2026-11-10): nothing is typed into an employer's page before the person's tap. An
  // employer can save each field as it is typed (Ashby's ApiSetFormValue autosave), so a fill before the tap would send the
  // answers before the yes, and the extension has no network guard. Off: the extension reads the form, plans and shows the
  // card; the person types their own answers, and the card shows them as theirs. On only in a test world (the fill engine's
  // tests load a copy with it switched on). Fixed here, never by storage (a page can write storage).
  prefill: false,
};
