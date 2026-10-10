// The transfer engine. Runs in a Web Worker so it keeps going while the tab is in the background.
// State lives in IndexedDB: closing the tab and shipping the same folder again resumes where it stopped.
//
// How it works (Drive API, consumer accounts):
//   1) A creates a permission for B: role=writer, pendingOwner=true   (sends no email)
//   2) B accepts: permissions.update role=owner, transferOwnership=true
//   -> Files are NOT copied; only the owner changes. Every file and folder is transferred on its own.
import { AuthError, Drive, DriveError } from "./drive";
import type { FromWorker, JobState, LogLine, RootRow, StartMsg, ToWorker } from "./types";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const SHORTCUT_MIME = "application/vnd.google-apps.shortcut"; // owner follows the parent folder, cannot be transferred
const WORKERS = 4;
const SAMPLE = 200;
const TAIL = 250;

type Status = "new" | "offered" | "done" | "skip" | "error";
type Item = { root: string; id: string; name: string; mime: string; parent: string | null; status: Status;
              perm_id?: string | null; err?: string | null; scanned?: 1 };
type StoredLog = LogLine & { root: string };

const fmt = (n: number) => n.toLocaleString("en-US");
const errMsg = (e: unknown) => String((e as Error)?.message || e).slice(0, 500);
const send = (m: FromWorker) => self.postMessage(m);

// ---------------------------------------------------------------- IndexedDB
let dbp: Promise<IDBDatabase> | undefined;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open("drive-move-out", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("items", { keyPath: ["root", "id"] }).createIndex("root", "root");
      d.createObjectStore("roots", { keyPath: "id" });
      d.createObjectStore("log", { autoIncrement: true }).createIndex("root", "root");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}
const req = <T,>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function tx<T>(stores: string | string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => T | Promise<T>) {
  const t = (await db()).transaction(stores, mode);
  const done = new Promise((res, rej) => { t.oncomplete = res; t.onerror = t.onabort = () => rej(t.error); });
  const out = await fn(t);
  await done;
  return out;
}
const rootItems = (root: string) =>
  tx("items", "readonly", t => req(t.objectStore("items").index("root").getAll(root) as IDBRequest<Item[]>));
const putItem = (item: Item) => tx("items", "readwrite", t => { t.objectStore("items").put(item); });

function logTail(root: string) {
  return tx("log", "readonly", t => new Promise<LogLine[]>((res, rej) => {
    const out: LogLine[] = [];
    const c = t.objectStore("log").index("root").openCursor(IDBKeyRange.only(root), "prev");
    c.onsuccess = () => {
      const cur = c.result;
      if (cur && out.length < TAIL) {
        const { t: time, status, id, name, err } = cur.value as StoredLog;
        out.push({ t: time, status, id, name, err });
        cur.continue();
      } else res(out.reverse());
    };
    c.onerror = () => rej(c.error);
  }));
}

function countStatuses(items: Item[]) {
  const s: Record<string, number> = {};
  let err = 0;
  for (const it of items) { s[it.status] = (s[it.status] || 0) + 1; err += Number(it.err != null); }
  return { s, err };
}

async function roots(): Promise<RootRow[]> {
  const list = await tx("roots", "readonly", t => req(t.objectStore("roots").getAll() as IDBRequest<{ id: string; name: string; added: number }[]>));
  list.sort((a, b) => b.added - a.added);
  return Promise.all(list.map(async r => {
    const { s, err } = countStatuses(await rootItems(r.id));
    return { id: r.id, name: r.name, done: s.done || 0, skip: s.skip || 0,
             todo: (s.new || 0) + (s.offered || 0) + (s.error || 0), err };
  }));
}

/** Delete one folder's saved progress, manifest and history row. */
async function forget(root: string) {
  await tx(["items", "log", "roots"], "readwrite", t => {
    const del = (store: string) => {
      const c = t.objectStore(store).index("root").openKeyCursor(IDBKeyRange.only(root));
      c.onsuccess = () => { const cur = c.result; if (cur) { t.objectStore(store).delete(cur.primaryKey); cur.continue(); } };
    };
    del("items");
    del("log");
    t.objectStore("roots").delete(root);
  });
}

const clearAll = () => tx(["items", "log", "roots"], "readwrite", t => {
  for (const s of ["items", "log", "roots"]) t.objectStore(s).clear();
});

// ---------------------------------------------------------------- job state (what the page renders)
const job: JobState = { status: "idle", steps: [], console: [], live: "", progress: null, scanned: null,
                        root: null, rootName: null, authExpired: false, items: [] };
let stopping = false;
let lastPost = 0;
let postTimer: ReturnType<typeof setTimeout> | null = null;

function post(force = false) {
  const now = Date.now();
  if (!force && now - lastPost < 400) {
    postTimer ??= setTimeout(() => { postTimer = null; post(true); }, 400);
    return;
  }
  lastPost = now;
  send({ type: "state", state: job });
}
function print(line: string) { job.console.push(line); if (job.console.length > 400) job.console.shift(); job.live = ""; post(); }
function live(line: string) { job.live = line; post(); }

async function printStats(root: string) {
  const { s, err } = countStatuses(await rootItems(root));
  const todo = (s.new || 0) + (s.offered || 0) + (s.error || 0), total = todo + (s.done || 0);
  const pct = total ? (100 * (s.done || 0)) / total : 0;
  print(`[${job.rootName || root}]  ` + Object.keys(s).sort().map(k => `${k}=${fmt(s[k])}`).join("  ")
    + `  | with error=${fmt(err)}  | progress ${pct.toFixed(1)}%`);
  return err;
}

// ---------------------------------------------------------------- steps
// Owned by A -> to transfer; already owned by B (moved earlier) -> done; anything else (shortcuts, other owners) -> skip
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function initialStatus(f: any, emailB: string): Status {
  if (f.mimeType === SHORTCUT_MIME) return "skip";
  if (f.ownedByMe) return "new";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (f.owners || []).some((o: any) => (o.emailAddress || "").toLowerCase() === emailB.toLowerCase()) ? "done" : "skip";
}

async function scan(A: Drive, root: string, emailB: string) {
  const r = await A.req("GET", `/files/${root}`, { query: { fields: "id,name,mimeType,ownedByMe,owners(emailAddress)" } });
  job.rootName = r.name;
  print(`Root: ${r.name}`);
  const known = new Map((await rootItems(root)).map(it => [it.id, it]));
  await tx("roots", "readwrite", t => { t.objectStore("roots").put({ id: root, name: r.name, added: Date.now() }); });
  if (!known.has(root)) {
    const it: Item = { root, id: root, name: r.name, mime: r.mimeType, parent: null, status: initialStatus(r, emailB) };
    await putItem(it);
    known.set(root, it);
  }
  const queue = [...known.values()].filter(it => it.mime === FOLDER_MIME && !it.scanned);
  let total = known.size;
  while (queue.length) {
    if (stopping) return;
    const folder = queue.shift()!;
    let pageToken: string | undefined;
    do {
      const res = await A.req("GET", "/files", { query: {
        q: `'${folder.id}' in parents and trashed=false`,
        fields: "nextPageToken, files(id,name,mimeType,ownedByMe,owners(emailAddress))",
        pageSize: "1000", ...(pageToken ? { pageToken } : {}) } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fresh: Item[] = (res.files || []).filter((f: any) => !known.has(f.id)).map((f: any) => ({
        root, id: f.id, name: f.name, mime: f.mimeType, parent: folder.id, status: initialStatus(f, emailB) }));
      await tx("items", "readwrite", t => { const s = t.objectStore("items"); fresh.forEach(it => s.put(it)); });
      for (const it of fresh) { known.set(it.id, it); if (it.mime === FOLDER_MIME) queue.push(it); }
      total += fresh.length;
      job.scanned = total;
      live(`Scanned: ${fmt(total)} items`);
      pageToken = res.nextPageToken;
    } while (pageToken);
    folder.scanned = 1;
    await putItem(folder);
  }
  print(`Scanned: ${fmt(total)} items`);
  await printStats(root);
}

async function findPermId(A: Drive, fileId: string, email: string) {
  const res = await A.req("GET", `/files/${fileId}/permissions`, { query: { fields: "permissions(id,emailAddress)" } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (res.permissions || []).find((p: any) => (p.emailAddress || "").toLowerCase() === email.toLowerCase())?.id || null;
}

async function transferOne(A: Drive, B: Drive, fileId: string, permId: string | null | undefined, emailB: string):
    Promise<{ status: Status; permId: string | null; err: string | null }> {
  try {
    if (!permId) {
      try {
        permId = (await A.req("POST", `/files/${fileId}/permissions`, {
          query: { sendNotificationEmail: "false", fields: "id" },
          body: { type: "user", role: "writer", emailAddress: emailB, pendingOwner: true } })).id;
      } catch (e) {
        // B may already have access (e.g. inherited from a parent folder) -> update instead
        if (!(e instanceof DriveError)) throw e;
        permId = await findPermId(A, fileId, emailB);
        if (!permId) throw e;
      }
    }
    // If B already had access, create() ignores pendingOwner -> always set it explicitly before B accepts.
    await A.req("PATCH", `/files/${fileId}/permissions/${permId}`, { body: { role: "writer", pendingOwner: true } });
    await B.req("PATCH", `/files/${fileId}/permissions/${permId}`, { query: { transferOwnership: "true" }, body: { role: "owner" } });
    return { status: "done", permId: permId!, err: null };
  } catch (e) {
    if (e instanceof AuthError) throw e;
    // Already transferred (e.g. the tab was closed before the result was saved)
    try {
      if ((await B.req("GET", `/files/${fileId}`, { query: { fields: "ownedByMe" }, maxTries: 3 })).ownedByMe)
        return { status: "done", permId: permId ?? null, err: null };
    } catch {}
    return { status: permId ? "offered" : "error", permId: permId ?? null, err: errMsg(e) };
  }
}

function hms(sec: number) {
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 3600)}:${String(Math.floor(sec / 60) % 60).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

/** Overall progress of the folder (earlier runs included), so a resumed run does not start from 0%. */
async function baseline(root: string) {
  const all = await rootItems(root);
  const rows = all.filter(it => (it.status === "new" || it.status === "offered") && it.err == null);
  const before = all.filter(it => it.status === "done").length;
  return { rows, before, total: before + rows.length };
}

async function transfer(A: Drive, B: Drive, root: string, emailB: string) {
  const { rows, before, total } = await baseline(root);
  print(`To transfer: ${fmt(rows.length)} items (${fmt(before)} already done)`);
  const t0 = Date.now();
  let i = 0, n = 0, nDone = 0, nErr = 0;
  const progress = () => {
    const rate = n / Math.max((Date.now() - t0) / 1000, 1e-9);
    const p = { pct: total ? (100 * (before + n)) / total : 100, n: before + n, total, done: before + nDone, err: nErr,
                rate: Math.round(rate * 60), eta: hms(rate > 0 ? (rows.length - n) / rate : 0) };
    job.progress = p;
    live(`[${p.pct.toFixed(1).padStart(5)}%] ${fmt(p.n)}/${fmt(total)}  done=${fmt(p.done)}  err=${fmt(nErr)}  ${fmt(p.rate)}/min  ETA ${p.eta}`);
  };
  progress();
  await Promise.all(Array.from({ length: Math.min(WORKERS, rows.length) }, async () => {
    while (i < rows.length && !stopping) {
      const it = rows[i++];
      const r = await transferOne(A, B, it.id, it.perm_id, emailB);
      Object.assign(it, { status: r.status, perm_id: r.permId, err: r.err });
      const l: StoredLog = { root, t: new Date().toTimeString().slice(0, 8), status: r.status, id: it.id, name: it.name, err: r.err };
      await tx(["items", "log"], "readwrite", t => { t.objectStore("items").put(it); t.objectStore("log").add(l); });
      job.items.push({ t: l.t, status: l.status, id: l.id, name: l.name, err: l.err });
      if (job.items.length > TAIL) job.items.shift();
      n++; nDone += Number(r.status === "done"); nErr += Number(r.err != null);
      progress();
    }
  }));
  if (job.live) print(job.live);
  return printStats(root);
}

async function retryErrors(root: string) {
  const bad = (await rootItems(root)).filter(it => it.err != null);
  await tx("items", "readwrite", t => {
    const s = t.objectStore("items");
    for (const it of bad) s.put({ ...it, err: null, status: it.perm_id ? "offered" : "new" });
  });
  print(`Reset ${fmt(bad.length)} failed items`);
  await printStats(root);
}

async function verify(B: Drive, root: string) {
  await printStats(root);
  const done = (await rootItems(root)).filter(it => it.status === "done");
  for (let k = done.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [done[k], done[j]] = [done[j], done[k]]; }
  const ids = done.slice(0, SAMPLE).map(it => it.id);
  const bad: string[] = [];
  let i = 0;
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (i < ids.length) {
      const id = ids[i++];
      if (!(await B.req("GET", `/files/${id}`, { query: { fields: "ownedByMe" } })).ownedByMe) bad.push(id);
      live(`Checking ${i}/${ids.length}…`);
    }
  }));
  print(`Spot-checked ${ids.length} 'done' files with account B: ${ids.length - bad.length} owned by B, ${bad.length} not`);
  bad.slice(0, 20).forEach(id => print(`  NOT OWNED: ${id}`));
}

// ---------------------------------------------------------------- job
async function run({ mode, root, emailA, emailB, tokens }: StartMsg) {
  const names = mode === "retry" ? ["retry-errors", "transfer", "verify"] : ["scan", "transfer", "verify"];
  stopping = false;
  Object.assign(job, { status: "running", authExpired: false, steps: names.map(name => ({ name, status: "pending" })),
                       progress: null, scanned: null, live: "", console: [],
                       rootName: root === job.root ? job.rootName : null, root, items: await logTail(root) });
  const b = await baseline(root);
  if (b.total) job.progress = { pct: (100 * b.before) / b.total, n: b.before, total: b.total, done: b.before, err: 0, rate: 0, eta: "—" };
  post(true);

  let status: JobState["status"] = "done";
  try {
    const A = new Drive(tokens.A), B = new Drive(tokens.B);
    const [gotA, gotB] = [await A.email(), await B.email()];
    print(`A = ${gotA}   B = ${gotB}`);
    if (gotA.toLowerCase() !== emailA.toLowerCase() || gotB.toLowerCase() !== emailB.toLowerCase())
      throw new AuthError("The logged-in accounts do not match email A / email B");
    if (gotA.toLowerCase() === gotB.toLowerCase()) throw new Error("A and B are the same account?!");

    for (const st of job.steps) {
      if (stopping) break;
      st.status = "running";
      print(`$ ${st.name}`);
      let warn = false;
      if (st.name === "scan") await scan(A, root, gotB);
      else if (st.name === "retry-errors") await retryErrors(root);
      else if (st.name === "transfer") { warn = (await transfer(A, B, root, gotB)) > 0; }
      else if (st.name === "verify") await verify(B, root);
      if (stopping) { st.status = "stopped"; break; }
      st.status = warn ? "warn" : "ok";
      if (warn) { status = "errors"; print("Some items failed — see the Manifest (lines with ERR)"); }
    }
  } catch (e) {
    const st = job.steps.find(s => s.status === "running");
    if (st) st.status = "fail";
    status = "failed";
    if (e instanceof AuthError) job.authExpired = true;
    print(`ERROR: ${errMsg(e)}`);
  }
  job.status = stopping ? "stopped" : status;
  post(true);
}

self.onmessage = async ({ data }: MessageEvent<ToWorker>) => {
  if (data.cmd === "start") {
    if (job.status === "running") return send({ type: "error", error: "A job is already running" });
    run(data);
  } else if (data.cmd === "stop") {
    if (job.status === "running") { stopping = true; print("Stopping after the files in flight…"); }
  } else if (data.cmd === "roots") {
    send({ type: "roots", roots: await roots() });
  } else if (data.cmd === "forget" || data.cmd === "clearAll") {
    if (job.status === "running") return send({ type: "error", error: "Stop the transfer before deleting saved data" });
    if (data.cmd === "forget") await forget(data.root); else await clearAll();
    if (data.cmd === "clearAll" || job.root === data.root)  // the board was showing it -> back to idle
      Object.assign(job, { status: "idle", steps: [], console: [], live: "", progress: null, scanned: null,
                           root: null, rootName: null, authExpired: false, items: [] });
    post(true);
    send({ type: "roots", roots: await roots() });
  } else if (data.cmd === "state") {
    post(true);
  }
};
