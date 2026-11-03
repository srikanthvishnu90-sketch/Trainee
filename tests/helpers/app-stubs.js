// Browser stubs for running the Upmore app script in a Node vm sandbox.
// The app is a single-page PWA; at load it touches document/window/
// localStorage/navigator. These stubs make load-time code no-op safely so
// the pure engines (Guide, CFO calculators, budget, investments, net worth)
// can be exercised deterministically with zero network and zero API cost.

function makeElement(tag) {
  const el = {
    tagName: (tag || "div").toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    _innerHTML: "",
    _textContent: "",
    classList: {
      add() {}, remove() {}, toggle() {}, contains() { return false; },
    },
    set innerHTML(v) { this._innerHTML = String(v); },
    get innerHTML() { return this._innerHTML; },
    set textContent(v) { this._textContent = String(v); },
    get textContent() { return this._textContent; },
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { return c; },
    insertBefore(c) { this.children.push(c); return c; },
    remove() {},
    click() {},
    focus() {},
    blur() {},
    querySelector() { return makeElement(); },
    querySelectorAll() { return []; },
    getAttribute() { return null; },
    setAttribute() {},
    hasAttribute() { return false; },
    closest() { return null; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 100 }; },
    value: "",
    checked: false,
    disabled: false,
    scrollTop: 0,
    scrollHeight: 0,
  };
  return el;
}

function buildContext() {
  const store = {};
  const els = {};
  const byId = (id) => {
    if (!els[id]) els[id] = makeElement();
    return els[id];
  };

  const documentStub = {
    getElementById: byId,
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
    createElement: (t) => makeElement(t),
    createTextNode: (t) => ({ textContent: String(t) }),
    addEventListener() {},
    removeEventListener() {},
    documentElement: makeElement("html"),
    body: makeElement("body"),
    head: makeElement("head"),
    title: "",
  };

  const localStorageStub = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    key: (i) => Object.keys(store)[i] || null,
    get length() { return Object.keys(store).length; },
  };

  // Supabase client stub: unauthenticated. getSessionToken() resolves null,
  // so agentAsk() returns null and the chat falls back to the local Guide
  // engine — exactly the deterministic layer dry-run agents exercise.
  const supabaseStub = {
    createClient: () => ({
      auth: {
        getSession: async () => ({ data: { session: null }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        signInWithOAuth: async () => ({}),
        signOut: async () => ({}),
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
            maybeSingle: async () => ({ data: null, error: null }),
            order: () => ({ data: [], error: null }),
          }),
          order: () => ({ data: [], error: null }),
        }),
        insert: async () => ({ data: null, error: null }),
        upsert: async () => ({ data: null, error: null }),
        delete: () => ({ eq: async () => ({ error: null }) }),
      }),
      rpc: async () => ({ data: null, error: null }),
    }),
  };

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URLSearchParams, URL,
    document: documentStub,
    window: null, // assigned below (needs document/localStorage first)
    navigator: {
      userAgent: "node-agent100/1.0",
      platform: "node",
      maxTouchPoints: 0,
      language: "en-US",
    },
    location: {
      search: "",
      hash: "",
      href: "https://upmore-srikanthvishnu90-sketchs-projects.vercel.app/",
      pathname: "/",
      origin: "https://upmore-srikanthvishnu90-sketchs-projects.vercel.app",
      reload() {},
    },
    localStorage: localStorageStub,
    sessionStorage: {
      _s: {},
      getItem(k) { return this._s[k] ?? null; },
      setItem(k, v) { this._s[k] = String(v); },
      removeItem(k) { delete this._s[k]; },
    },
    // Network is denied in dry-run: any fetch returns not-ok so code paths
    // that require a backend fail closed instead of hanging.
    fetch: async () => ({ ok: false, status: 0, json: async () => ({}), text: async () => "" }),
    requestAnimationFrame: (f) => setTimeout(f, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    crypto: require("crypto").webcrypto,
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    innerWidth: 414,
    innerHeight: 868,
    devicePixelRatio: 2,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    screen: { width: 414, height: 868 },
    history: { pushState() {}, replaceState() {}, back() {} },
    scrollTo() {},
  };
  sandbox.window = {
    document: documentStub,
    localStorage: localStorageStub,
    navigator: sandbox.navigator,
    location: sandbox.location,
    supabase: supabaseStub,
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 414,
    innerHeight: 868,
    open: () => null,
  };
  sandbox.globalThis = sandbox;
  return { sandbox, byId, store };
}

module.exports = { buildContext, makeElement };
