"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const hash = (v) => crypto.createHash("sha256").update(typeof v === "string" || Buffer.isBuffer(v) ? v : JSON.stringify(v)).digest("hex");
const fail = (code, message = code) => Object.assign(new Error(message), { code });
const clone = (v) => JSON.parse(JSON.stringify(v));

// Local durable implementation. A distributed deployment needs a transactional
// adapter with equivalent compare-and-set/lease semantics, not an NFS mount.
function createFileTaskStore(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const safe = (id) => { if (!/^[a-f0-9]{32}$/.test(id)) throw fail("TASK_ID_INVALID"); return path.join(root, id + ".json"); };
  function get(id) {
    try { return JSON.parse(fs.readFileSync(safe(id), "utf8")); }
    catch (e) { if (e.code === "ENOENT") return null; throw e; }
  }
  function put(task) {
    const target = safe(task.id);
    task.revision = (task.revision || 0) + 1;
    const temp = target + "." + crypto.randomUUID() + ".tmp";
    const fd = fs.openSync(temp, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(task)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, target);
    const dir = fs.openSync(root, "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
  // Mass submission (D-MS-2): several engine processes for one person may reach this lock at once. Its holder runs a
  // synchronous critical section of milliseconds, so a live holder is waited for (up to busyMs), never stolen.
  const pause = new Int32Array(new SharedArrayBuffer(4));
  function acquire(lock) {
    try { return fs.openSync(lock, "wx", 0o600); }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      // Never steal an aged lease. Only a demonstrably dead local owner may
      // be recovered; a reused PID conservatively keeps the lease locked.
      let owner;
      try { owner = JSON.parse(fs.readFileSync(lock, "utf8")); }
      catch (r) { if (r.code === "ENOENT" || r instanceof SyntaxError) return null; throw r; } // released, or being written
      try { process.kill(owner.pid, 0); return null; }
      catch (alive) { if (alive.code !== "ESRCH") throw alive; }
      try { fs.unlinkSync(lock); } catch (u) { if (u.code !== "ENOENT") throw u; }
      return null;
    }
  }
  function withLock(id, fn, busyMs = 10000) {
    const lock = safe(id) + ".lock";
    let fd = null;
    for (const until = Date.now() + busyMs; fd === null; ) {
      fd = acquire(lock);
      if (fd === null) {
        if (Date.now() >= until) throw fail("TASK_BUSY");
        Atomics.wait(pause, 0, 0, 10 + Math.floor(Math.random() * 15));
      }
    }
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.fsyncSync(fd);
    try {
      const out = fn();
      if (out && typeof out.then === "function") throw fail("STORE_REQUIRES_SYNC_TRANSACTION");
      return out;
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  return { get, put, withLock, list: () => fs.readdirSync(root).filter((x) => /^[a-f0-9]{32}\.json$/.test(x)).map((x) => x.slice(0, -5)) };
}
module.exports = { createFileTaskStore, hash, fail, clone };
