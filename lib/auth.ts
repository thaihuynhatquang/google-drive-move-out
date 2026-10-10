// Google sign-in by full-page redirect + PKCE (popups hang on some browsers' consent screens).
// The client secret stays in /api/oauth. Tokens live in this tab's sessionStorage only,
// which survives the round trip to Google because it is the same tab.
import { Drive, oauth, type Token } from "./drive";

export type Label = "A" | "B";
export type Saved = { email: string; token: Token };
type Pending = { label: Label; email: string; verifier: string; state: string };

export const ROLE: Record<Label, string> = { A: "current owner", B: "new owner" };
export const same = (a?: string, b?: string) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

const get = <T,>(k: string): T | null => { try { return JSON.parse(sessionStorage.getItem(k) || "null"); } catch { return null; } };
const put = (k: string, v: unknown) => {
  try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, JSON.stringify(v)); } catch {}
};

export const session = {
  get: (l: Label) => get<Saved>("tok_" + l),
  set: (l: Label, v: Saved | null) => put("tok_" + l, v),
  /** One-shot message shown on the main page after coming back from Google. */
  flash: (v?: { text: string; ok: boolean }) => {
    if (v) return put("flash", v);
    const f = get<{ text: string; ok: boolean }>("flash");
    put("flash", null);
    return f;
  },
};

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const redirectUri = () => location.origin + "/callback";

/** Leaves the page for Google's sign-in. */
export async function startLogin(label: Label, email: string) {
  const { clientId } = await oauth<{ clientId: string }>("config");
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  put("oauth_pending", { label, email, verifier, state } satisfies Pending);
  location.assign("https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri(), response_type: "code",
    scope: "https://www.googleapis.com/auth/drive", access_type: "offline", prompt: "select_account consent",
    code_challenge: challenge, code_challenge_method: "S256", state, login_hint: email,
  }));
}

/** Runs on /callback: exchanges the code, checks the account, stores the token. Returns the message to show. */
export async function finishLogin(q: URLSearchParams): Promise<{ text: string; ok: boolean }> {
  const p = get<Pending>("oauth_pending");
  put("oauth_pending", null);
  if (!p || q.get("state") !== p.state) return { text: "Sign-in failed: the request expired, try again.", ok: false };
  const who = `${ROLE[p.label][0].toUpperCase()}${ROLE[p.label].slice(1)}`;
  if (!q.get("code")) return { text: `${who}: sign-in cancelled (${q.get("error") || "no code"}).`, ok: false };
  try {
    const t = await oauth<{ access_token: string; refresh_token: string; expires_in: number }>(
      "exchange", { code: q.get("code"), code_verifier: p.verifier, redirect_uri: redirectUri() });
    const token: Token = { access_token: t.access_token, refresh_token: t.refresh_token, expiry_date: Date.now() + t.expires_in * 1000 };
    const got = await new Drive(token).email();
    if (!same(got, p.email)) {
      await oauth("revoke", { token: token.refresh_token }).catch(() => {});
      return { text: `${who}: you signed in as ${got}, expected ${p.email}.`, ok: false };
    }
    const old = session.get(p.label);
    if (old?.token.refresh_token) oauth("revoke", { token: old.token.refresh_token }).catch(() => {});
    session.set(p.label, { email: got, token });
    return { text: `Signed in as ${got} (${ROLE[p.label]}).`, ok: true };
  } catch (e) {
    return { text: `${who}: ${(e as Error).message}`, ok: false };
  }
}
