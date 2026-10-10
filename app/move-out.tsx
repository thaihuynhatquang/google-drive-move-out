"use client";
// Page logic: Google sign-in (redirect + PKCE, see lib/auth), talking to the transfer worker, rendering.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ROLE, same, session, startLogin, type Label, type Saved } from "@/lib/auth";
import { oauth } from "@/lib/drive";
import type { FromWorker, JobState, JobStatus, LogLine, RootRow, ToWorker } from "@/lib/types";

type Banner = { title: string; text: string; retry: boolean };

const IDLE: JobState = { status: "idle", steps: [], console: [], live: "", progress: null, scanned: null,
                         root: null, rootName: null, authExpired: false, items: [] };
const STAMP: Record<JobStatus, string> = { idle: "Idle", running: "In transit", done: "Delivered",
  errors: "Partly delivered", failed: "Failed", stopped: "Stopped" };
const DEFAULT_STEPS = ["scan", "transfer", "verify"].map(name => ({ name, status: "pending" as const }));

const fmt = (n: number | null | undefined) => n == null ? "—" : Number(n).toLocaleString("en-US");

// Emails: localStorage (convenience). OAuth tokens: sessionStorage via lib/auth (this tab only).
const local = {
  get: (k: string) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} },
};

// The running job, so a reload can resume it (this tab only; no secrets)
type Active = { root: string; emailA: string; emailB: string };
const activeJob = {
  get: (): Active | null => { try { return JSON.parse(sessionStorage.getItem("activeJob") || "null"); } catch { return null; } },
  set: (v: Active | null) => {
    try { v ? sessionStorage.setItem("activeJob", JSON.stringify(v)) : sessionStorage.removeItem("activeJob"); } catch {}
  },
};

function parseRoot(raw: string) {
  raw = raw.trim();
  // folder: .../folders/<id>   file: .../file/d/<id>/view, docs.google.com/document/d/<id>/edit   old: ?id=<id>
  const m = raw.match(/(?:folders|\/d)\/([\w-]+)/) || raw.match(/[?&]id=([\w-]+)/);
  return m ? m[1] : raw;
}

// ---------------------------------------------------------------- component
export default function MoveOut() {
  const [emails, setEmails] = useState<Record<Label, string>>({ A: "", B: "" });
  const [root, setRoot] = useState("");
  const [msg, setMsg] = useState<{ text: string; ok?: boolean }>({ text: "" });
  const [toks, setToks] = useState<Partial<Record<Label, Saved>>>({});
  const [loggingIn, setLoggingIn] = useState<Label | null>(null);
  const [job, setJob] = useState<JobState>(IDLE);
  const [roots, setRoots] = useState<RootRow[]>([]);
  const [banner, setBanner] = useState<Banner | null>(null);
  const worker = useRef<Worker | null>(null);
  const prevStatus = useRef<JobStatus>("idle");
  const rootInput = useRef<HTMLInputElement>(null);
  const goingToGoogle = useRef(false);
  const reloading = useRef(false);

  const say = (text: string, ok = false) => setMsg({ text, ok });
  const send = (m: ToWorker) => worker.current?.postMessage(m);
  const saveTok = useCallback((l: Label, v: Saved | null) => {
    session.set(l, v);
    setToks(t => ({ ...t, [l]: v ?? undefined }));
  }, []);

  // browser-only state + the worker
  useEffect(() => {
    setEmails({ A: local.get("emailA"), B: local.get("emailB") });
    setToks({ A: session.get("A") ?? undefined, B: session.get("B") ?? undefined });
    setRoot(local.get("rootDraft"));  // kept across the sign-in round trip only
    local.set("rootDraft", "");
    const flash = session.flash();  // result of a sign-in round trip
    if (flash) setMsg(flash);

    const w = new Worker(new URL("../lib/transfer.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = ({ data }: MessageEvent<FromWorker>) => {
      if (data.type === "roots") return setRoots(data.roots);
      if (data.type === "error") return say(data.error);
      const s = data.state;
      if (prevStatus.current === "running" && s.status !== "running") {  // finished -> offer the next folder
        const name = s.rootName || s.root;
        const b = ({
          done: { title: `“${name}” delivered.`, text: "Everything is owned by B now. Ship another folder?", retry: false },
          errors: { title: `“${name}” partly delivered.`, text: "Some files failed — retry them, or move on to another folder.", retry: true },
          failed: { title: "Something went wrong.", text: "Check the console, then retry or try another folder.", retry: false },
          stopped: { title: "Stopped.", text: "Progress is saved — shipping the same folder again resumes it.", retry: false },
        } as Partial<Record<JobStatus, Banner>>)[s.status];
        if (b) setBanner(b);
        if (s.authExpired) {
          saveTok("A", null); saveTok("B", null);
          say("Login expired or wrong account — sign in both accounts again, then Ship it (progress is kept).");
        }
        w.postMessage({ cmd: "roots" } satisfies ToWorker);
        activeJob.set(null);
      }
      prevStatus.current = s.status;
      setJob({ ...s });
    };
    w.onerror = e => say(`Worker error: ${e.message}`);
    worker.current = w;
    w.postMessage({ cmd: "state" } satisfies ToWorker);
    w.postMessage({ cmd: "roots" } satisfies ToWorker);

    // A reload (F5) kills the worker mid-transfer -> pick the same folder up again (progress is in IndexedDB)
    const resume = activeJob.get(), A = session.get("A"), B = session.get("B");
    if (resume && A && B && same(A.email, resume.emailA) && same(B.email, resume.emailB)) {
      setRoot(resume.root);
      say("Page reloaded — resuming the transfer…", true);
      w.postMessage({ cmd: "start", ...resume, tokens: { A: A.token, B: B.token } } satisfies ToWorker);
    } else activeJob.set(null);
    return () => { w.terminate(); worker.current = null; };
  }, [saveTok]);

  const running = job.status === "running";

  // Leaving the page (close, navigate away) signs out: revoke both grants at Google, so the next sign-in gets a
  // fresh consent screen. keepalive lets the request finish after the tab is gone. Exceptions: the trip to
  // Google's sign-in, and a keyboard reload (F5 / Ctrl+R). The browser's reload button can't be told apart from closing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // any other key: the reload was cancelled (e.g. "Leave site?" dialog) -> back to normal
      reloading.current = e.key === "F5" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r");
    };
    const onHide = () => {
      if (goingToGoogle.current || reloading.current) return;
      for (const l of ["A", "B"] as Label[]) {
        const t = session.get(l);
        if (!t?.token.refresh_token) continue;
        fetch("/api/oauth", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ action: "revoke", token: t.token.refresh_token }) }).catch(() => {});
        session.set(l, null);
      }
    };
    // back/forward cache: the page can come back after pagehide -> resync with the (now empty) storage
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) { goingToGoogle.current = reloading.current = false; setLoggingIn(null); setToks({ A: session.get("A") ?? undefined, B: session.get("B") ?? undefined }); }
    };
    const onPointer = () => { reloading.current = false; };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
    };
  }, []);

  // closing the tab stops the transfer -> ask first; show progress in the tab title
  useEffect(() => {
    document.title = running && job.progress ? `${Math.floor(job.progress.pct)}% · Drive Move-Out` : "Drive Move-Out";
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running, job.progress]);

  async function login(l: Label) {
    const email = emails[l].trim();
    if (!email) return say(`Enter the ${ROLE[l]}'s email first.`);
    local.set("email" + l, email);
    local.set("rootDraft", root);  // the page reloads after Google
    setLoggingIn(l);
    try {
      goingToGoogle.current = true;
      await startLogin(l, email);  // navigates away
    } catch (e) {
      say(`${ROLE[l][0].toUpperCase() + ROLE[l].slice(1)}: ${(e as Error).message}`);
      goingToGoogle.current = false;
      setLoggingIn(null);
    }
  }

  async function logout() {
    const list = (["A", "B"] as Label[]).map(l => toks[l]).filter(Boolean) as Saved[];
    const res = await Promise.all(list.map(t =>
      oauth("revoke", { token: t.token.refresh_token }).then(() => "revoked", () => "revoke failed")));
    saveTok("A", null); saveTok("B", null);
    say("Signed out · access " + (res.join(", ") || "cleared"), true);
  }

  function start(mode?: "retry") {
    say("");
    const emailA = emails.A.trim(), emailB = emails.B.trim(), id = parseRoot(root);
    if (!emailA || !emailB || !id) return say("Fill in all three fields.");
    if (!toks.A || !same(toks.A.email, emailA)) return say("Sign in the current owner first (button under their email).");
    if (!toks.B || !same(toks.B.email, emailB)) return say("Sign in the new owner first (button under their email).");
    local.set("emailA", emailA); local.set("emailB", emailB);
    setBanner(null);
    activeJob.set({ root: id, emailA, emailB });
    send({ cmd: "start", mode, root: id, emailA, emailB, tokens: { A: toks.A.token, B: toks.B.token } });
  }

  const p = job.progress;
  const scanning = job.steps.some(s => s.name === "scan" && s.status === "running");
  const loggedIn = (["A", "B"] as Label[]).filter(l => toks[l]);

  return (
    <div className="wrap">
      <header>
        <h1>Drive<br /><span>Move-Out</span></h1>
        <div className="tagline">
          <div className="fragile">Handle with care</div><br />
          Ownership transfer · Google Drive<br />
          Files stay put — only the owner changes
        </div>
      </header>

      <div className="grid">
        {/* shipping label */}
        <form className="label" autoComplete="on" onSubmit={e => { e.preventDefault(); start(); }}>
          <div className="label-head">Shipping label <small>{job.root ? `No. ${job.root.slice(0, 10)}…` : "No. —"}</small></div>
          {(["A", "B"] as Label[]).map(l => (
            <div key={l} style={{ display: "contents" }}>
              {l === "B" && <div className="arrow-row">Ship to</div>}
              <div className="field">
                <label htmlFor={"email" + l}>{l === "A" ? "From · current owner" : "To · new owner"} <b>{l}</b></label>
                <input id={"email" + l} type="email" placeholder={`${l.toLowerCase()}@gmail.com`} required readOnly={running}
                       value={emails[l]} onChange={e => setEmails(m => ({ ...m, [l]: e.target.value }))} />
                <div className="who">
                  <span>
                    {toks[l]
                      ? <><span className={same(toks[l]!.email, emails[l]) ? "on" : ""}>{toks[l]!.email}</span>
                          {!same(toks[l]!.email, emails[l]) && " · differs from email"}</>
                      : "Not signed in"}
                  </span>
                  <button className="ghost pick" type="button" disabled={running || loggingIn !== null} onClick={() => login(l)}>
                    {loggingIn === l ? "Opening Google…" : toks[l] ? "Use another account" : "Sign in with Google"}
                  </button>
                </div>
              </div>
            </div>
          ))}
          <div className="field">
            <label htmlFor="root">Contents · folder or file <b>ID / URL</b></label>
            <input id="root" ref={rootInput} placeholder="drive.google.com/drive/folders/… or /file/d/…" required
                   readOnly={running} value={root} onChange={e => setRoot(e.target.value)} />
          </div>
          <div className="barcode" aria-hidden="true" />
          {msg.text && <div className="msg" style={msg.ok ? { color: "var(--ok)" } : undefined}>{msg.text}</div>}
          <div className="actions">
            <button className="primary" type="submit" disabled={running}>Ship it →</button>
            <button className="ghost" type="button" disabled={!running} onClick={() => send({ cmd: "stop" })}>Stop</button>
          </div>
          <div className="tokens">
            <span>{loggedIn.length
              ? <>Signed in: <span className="on">{loggedIn.map(l => ROLE[l]).join(" + ")}</span> · signs out when this tab closes</>
              : "Not signed in · nothing saved"}</span>
            <button className="ghost pick" type="button" disabled={running || !loggedIn.length} onClick={logout}>Sign out</button>
          </div>
        </form>

        {/* status board */}
        <section className="board">
          <div className="board-top">
            <div className="now">Now moving<strong>{job.rootName || job.root || "Nothing on the truck"}</strong>
              <div className={"keep" + (running ? " show" : "")}>Keep this tab open — it can stay in the background</div>
            </div>
            <div className={"stamp " + job.status}>{STAMP[job.status]}</div>
          </div>

          <div className="steps">
            {(job.steps.length ? job.steps : DEFAULT_STEPS).map(s => (
              <div key={s.name} className={"step " + s.status}><i />{s.name.replace("-", " ")}</div>
            ))}
          </div>

          <div className={"conveyor" + (running ? " moving" : "")}>
            <div className="fill" style={{ width: (p ? p.pct : job.status === "done" ? 100 : 0) + "%" }} />
            <div className="count">{p ? `${fmt(p.n)} / ${fmt(p.total)}` : scanning ? `scanning… ${fmt(job.scanned || 0)} items` : "0 / 0"}</div>
            <div className="pct">{p ? Math.floor(p.pct) : job.status === "done" ? 100 : 0}%</div>
          </div>
          <div className="stats">
            <div className="stat"><span>Moved</span><b>{fmt(p?.done)}</b></div>
            <div className="stat bad"><span>Failed</span><b>{fmt(p?.err)}</b></div>
            <div className="stat"><span>Speed / min</span><b>{fmt(p?.rate)}</b></div>
            <div className="stat"><span>ETA</span><b>{p?.eta ?? "—"}</b></div>
          </div>

          {banner && (
            <div className="banner show">
              <p><b>{banner.title}</b>{banner.text}</p>
              {banner.retry && <button className="ghost" type="button" onClick={() => start("retry")}>Retry failed</button>}
              <button className="primary" type="button"
                      onClick={() => { setBanner(null); setRoot(""); rootInput.current?.focus(); }}>Ship another folder</button>
            </div>
          )}

          <div className="panes">
            <div className="pane">
              <h3>Manifest <small>{job.items.length ? `last ${job.items.length}` : "per item"}</small></h3>
              <Scroll deps={job.items}>
                {job.items.length ? job.items.map((it, i) => <ItemRow key={i} it={it} />)
                  : <div className="empty">Each transferred file shows up here.</div>}
              </Scroll>
            </div>
            <div className="pane">
              <h3>Console <small>engine output</small></h3>
              <Scroll className="console" deps={[job.console, job.live]}>
                {job.console.length || job.live ? <>
                  {job.console.map((l, i) => <div key={i} className={l.startsWith("$ ") ? "cmd" : ""}>{l}</div>)}
                  {job.live && <div className="live">{job.live}</div>}
                </> : <div className="empty">Waiting for the first box.</div>}
              </Scroll>
            </div>
          </div>
        </section>
      </div>

      <section className="history">
        <h2>Delivered folders</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Folder</th><th>Progress</th><th style={{ textAlign: "right" }}>Moved</th>
              <th style={{ textAlign: "right" }}>Left</th><th style={{ textAlign: "right" }}>Errors</th>
              <th style={{ textAlign: "right" }}>Skipped</th><th /></tr></thead>
            <tbody>
              {roots.length ? roots.map(r => {
                const total = r.done + r.todo, pct = total ? Math.round((100 * r.done) / total) : 100;
                return (
                  <tr key={r.id}>
                    <td><div>{r.name}</div><div className="id">{r.id}</div></td>
                    <td><div className={"mini" + (pct === 100 ? " full" : "")}><div style={{ width: pct + "%" }} /></div></td>
                    <td className="num">{fmt(r.done)}</td>
                    <td className="num">{fmt(r.todo)}</td>
                    <td className="num" style={{ color: r.err ? "var(--bad)" : "inherit" }}>{fmt(r.err)}</td>
                    <td className="num">{fmt(r.skip)}</td>
                    <td><button className="pick ghost" type="button" onClick={() => { setRoot(r.id); rootInput.current?.focus(); }}>Load</button></td>
                  </tr>
                );
              }) : <tr><td colSpan={7} className="empty">No folders yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ItemRow({ it }: { it: LogLine }) {
  return (
    <div className="row">
      <span className="t">{it.t}</span>
      <span className={"s " + it.status}>{it.status}</span>
      <span className="n" title={it.name}>{it.name}{it.err && <span className="e">{it.err}</span>}</span>
    </div>
  );
}

/** Scroll box that sticks to the bottom while the user has not scrolled up. */
function Scroll({ children, className = "", deps }: { children: React.ReactNode; className?: string; deps: unknown }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [deps]);
  return (
    <div ref={ref} className={"scroll " + className}
         onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
      {children}
    </div>
  );
}
