"use client";
// Page logic: Google login (popup + PKCE, secret kept by /api/oauth), talking to the transfer worker, rendering.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Drive, oauth, type Token } from "@/lib/drive";
import type { FromWorker, JobState, JobStatus, LogLine, RootRow, ToWorker } from "@/lib/types";

type Label = "A" | "B";
type Saved = { email: string; token: Token };
type Banner = { title: string; text: string; retry: boolean };

const IDLE: JobState = { status: "idle", steps: [], console: [], live: "", progress: null, scanned: null,
                         root: null, rootName: null, authExpired: false, items: [] };
const STAMP: Record<JobStatus, string> = { idle: "Idle", running: "In transit", done: "Delivered",
  errors: "Partly delivered", failed: "Failed", stopped: "Stopped" };
const ROLE: Record<Label, string> = { A: "current owner", B: "new owner" };
const DEFAULT_STEPS = ["scan", "transfer", "verify"].map(name => ({ name, status: "pending" as const }));

const fmt = (n: number | null | undefined) => n == null ? "—" : Number(n).toLocaleString("en-US");
const same = (a?: string, b?: string) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

// Emails: localStorage (convenience). OAuth tokens: this tab's sessionStorage only (gone when the tab closes).
const local = {
  get: (k: string) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} },
};
const session = {
  get: (l: Label): Saved | null => { try { return JSON.parse(sessionStorage.getItem("tok_" + l) || "null"); } catch { return null; } },
  set: (l: Label, v: Saved | null) => {
    try { v ? sessionStorage.setItem("tok_" + l, JSON.stringify(v)) : sessionStorage.removeItem("tok_" + l); } catch {}
  },
};

function parseRoot(raw: string) {
  raw = raw.trim();
  // folder: .../folders/<id>   file: .../file/d/<id>/view, docs.google.com/document/d/<id>/edit   old: ?id=<id>
  const m = raw.match(/(?:folders|\/d)\/([\w-]+)/) || raw.match(/[?&]id=([\w-]+)/);
  return m ? m[1] : raw;
}

// ---------------------------------------------------------------- login (popup + PKCE)
const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
let configP: Promise<{ clientId: string }> | undefined;

function waitForCode(state: string, popup: Window) {
  // /callback reports through a BroadcastChannel (Google's pages cut window.opener)
  return new Promise<string>((resolve, reject) => {
    const ch = new BroadcastChannel("oauth");
    let closedSince = 0;
    const finish = () => { clearTimeout(timer); clearInterval(watch); ch.close(); };
    const timer = setTimeout(() => { finish(); reject(new Error("Login timed out")); }, 300_000);
    const watch = setInterval(() => {  // popup closed without answering (closed can flicker -> grace period)
      if (!popup.closed) return;
      if (!closedSince) closedSince = Date.now();
      else if (Date.now() - closedSince > 3000) { finish(); reject(new Error("Login window was closed")); }
    }, 1000);
    ch.onmessage = ({ data }) => {
      if (data?.state !== state) return;
      finish();
      data.code ? resolve(data.code) : reject(new Error(`Login failed: ${data.error || "no code"}`));
    };
  });
}

async function googleLogin(popup: Window, email: string): Promise<Saved> {
  configP ??= oauth<{ clientId: string }>("config");
  configP.catch(() => { configP = undefined; });
  const { clientId } = await configP;
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const redirectUri = location.origin + "/callback";
  popup.location.href = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code",
    scope: "https://www.googleapis.com/auth/drive", access_type: "offline", prompt: "select_account consent",
    code_challenge: challenge, code_challenge_method: "S256", state, login_hint: email,
  });
  const code = await waitForCode(state, popup);
  const t = await oauth<{ access_token: string; refresh_token: string; expires_in: number }>(
    "exchange", { code, code_verifier: verifier, redirect_uri: redirectUri });
  const token: Token = { access_token: t.access_token, refresh_token: t.refresh_token, expiry_date: Date.now() + t.expires_in * 1000 };
  const got = await new Drive(token).email();
  if (!same(got, email)) {
    await oauth("revoke", { token: token.refresh_token }).catch(() => {});
    throw new Error(`You logged in as ${got}, expected ${email}`);
  }
  return { email: got, token };
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
      }
      prevStatus.current = s.status;
      setJob({ ...s });
    };
    w.onerror = e => say(`Worker error: ${e.message}`);
    worker.current = w;
    w.postMessage({ cmd: "state" } satisfies ToWorker);
    w.postMessage({ cmd: "roots" } satisfies ToWorker);
    return () => { w.terminate(); worker.current = null; };
  }, [saveTok]);

  const running = job.status === "running";

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
    // open the popup right away (inside the click) so it is not blocked
    const popup = window.open("about:blank", "gauth" + l, "width=520,height=680");
    if (!popup) return say("The browser blocked the login popup — allow popups for this site.");
    setLoggingIn(l);
    say(`Sign in as ${email} (${ROLE[l]}) in the Google popup…`, true);
    try {
      const saved = await googleLogin(popup, email);
      const old = toks[l];
      if (old?.token.refresh_token) oauth("revoke", { token: old.token.refresh_token }).catch(() => {});
      saveTok(l, saved);
      local.set("email" + l, email);
      say(`Signed in as ${email} (${ROLE[l]}).`, true);
    } catch (e) {
      say(`${ROLE[l][0].toUpperCase() + ROLE[l].slice(1)}: ${(e as Error).message}`);
    } finally {
      try { popup.close(); } catch {}
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
                    {loggingIn === l ? "Waiting for Google…" : toks[l] ? "Use another account" : "Sign in with Google"}
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
              ? <>Signed in: <span className="on">{loggedIn.map(l => ROLE[l]).join(" + ")}</span> · this tab only</>
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
