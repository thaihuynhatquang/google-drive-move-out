// Drive v3 client for the browser (page + worker). Access tokens are refreshed through
// the route handler /api/oauth, which holds the OAuth client secret.
const API = "https://www.googleapis.com/drive/v3";
const RETRY_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "backendError",
  "internalError", "sharingRateLimitExceeded"]);

export type Token = { access_token: string | null; refresh_token?: string; expiry_date: number };
export type OAuthAction = "config" | "exchange" | "refresh" | "revoke";

export class AuthError extends Error {}

export class DriveError extends Error {
  constructor(public status: number, public reason: string, message: string) {
    super(`HTTP ${status}${reason ? ` (${reason})` : ""}: ${message}`);
  }
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function oauth<T = Record<string, unknown>>(action: OAuthAction, payload: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch("/api/oauth", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...payload }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (j.error === "invalid_grant") throw new AuthError(j.message || "Login expired or was revoked");
    throw new Error(j.message || j.error || `oauth ${action}: HTTP ${r.status}`);
  }
  return j as T;
}

type ReqOpts = { query?: Record<string, string>; body?: unknown; maxTries?: number };

export class Drive {
  token: Token;
  /** Called whenever Google rate-limits a request (used to slow the transfer down). */
  onThrottle?: () => void;
  private refreshing: Promise<void> | null = null;

  constructor(token: Token) {
    this.token = { ...token };
  }

  async accessToken(): Promise<string> {
    if (this.token.access_token && this.token.expiry_date > Date.now() + 60_000) return this.token.access_token;
    if (!this.token.refresh_token) throw new AuthError("Not logged in");
    this.refreshing ??= oauth<{ access_token: string; expires_in: number }>("refresh", { refresh_token: this.token.refresh_token })
      .then(t => { this.token.access_token = t.access_token; this.token.expiry_date = Date.now() + t.expires_in * 1000; })
      .finally(() => { this.refreshing = null; });
    await this.refreshing;
    return this.token.access_token!;
  }

  /** Request with exponential backoff on rate limits, 5xx and network errors. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async req<T = any>(method: string, path: string, { query, body, maxTries = 10 }: ReqOpts = {}): Promise<T> {
    const url = API + path + (query ? "?" + new URLSearchParams(query) : "");
    for (let i = 0; i < maxTries; i++) {
      let r: Response;
      try {
        r = await fetch(url, {
          method,
          headers: { Authorization: `Bearer ${await this.accessToken()}`,
                     ...(body ? { "Content-Type": "application/json" } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        if (e instanceof AuthError) throw e;
        await sleep(Math.min(64, 2 ** i) * 1000 + Math.random() * 1000);  // network hiccup
        continue;
      }
      if (r.ok) return (r.status === 204 ? {} : await r.json()) as T;
      const j = await r.json().catch(() => ({}));
      const reason: string = j.error?.errors?.[0]?.reason || "";
      if (r.status === 401) { this.token.access_token = null; continue; }
      if ([429, 500, 502, 503, 504].includes(r.status) || (r.status === 403 && RETRY_REASONS.has(reason))) {
        if (r.status === 429 || r.status === 403) this.onThrottle?.();
        const wait = reason === "sharingRateLimitExceeded" ? 300 : Math.min(64, 2 ** i);
        await sleep(wait * 1000 + Math.random() * 1000);
        continue;
      }
      throw new DriveError(r.status, reason, j.error?.message || r.statusText);
    }
    throw new Error("Out of retries (still being rate-limited)");
  }

  async email(): Promise<string> {
    return (await this.req<{ user: { emailAddress: string } }>("GET", "/about", { query: { fields: "user(emailAddress)" } })).user.emailAddress;
  }
}
