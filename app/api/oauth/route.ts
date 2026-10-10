// POST /api/oauth — the only server-side piece: holds the OAuth client secret and talks to Google's token endpoint.
// Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, optional ALLOWED_ORIGINS (comma-separated, e.g. a custom domain)
// Actions: config | exchange {code, code_verifier, redirect_uri} | refresh {refresh_token} | revoke {token}
import type { NextRequest } from "next/server";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** Same-origin check. Behind a proxy (Netlify) req.nextUrl is the internal URL, so compare with the Host the browser used. */
function isAllowed(req: NextRequest, origin: string) {
  const extra = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (extra.includes(origin)) return true;
  let host: string;
  try { host = new URL(origin).host; } catch { return false; }
  const reqHost = req.headers.get("x-forwarded-host") || req.headers.get("host");
  return !!reqHost && host === reqHost.split(",")[0].trim();
}

export async function POST(req: NextRequest) {
  // Only our own pages may use the client secret
  const origin = req.headers.get("origin") || "";
  if (!isAllowed(req, origin)) return json(403, { error: "forbidden", message: `Origin ${origin} not allowed` });

  const clientId = process.env.GOOGLE_CLIENT_ID, clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret)
    return json(500, { error: "not_configured", message: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (.env.local / Netlify env)" });

  const body = await req.json().catch(() => ({}));
  const google = async (params: Record<string, string>) => {
    const r = await fetch(TOKEN_URL, {
      method: "POST", body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? json(200, { access_token: j.access_token, refresh_token: j.refresh_token, expires_in: j.expires_in })
                : json(400, { error: j.error || "token_error", message: j.error_description || `Google returned ${r.status}` });
  };

  switch (body.action) {
    case "config":
      return json(200, { clientId });
    case "exchange":
      if (body.redirect_uri !== `${origin}/callback`) return json(400, { error: "bad_redirect_uri" });
      return google({ grant_type: "authorization_code", code: String(body.code), code_verifier: String(body.code_verifier),
                      redirect_uri: body.redirect_uri });
    case "refresh":
      return google({ grant_type: "refresh_token", refresh_token: String(body.refresh_token) });
    case "revoke": {
      const r = await fetch(REVOKE_URL, { method: "POST", body: new URLSearchParams({ token: String(body.token || "") }) });
      return json(r.ok ? 200 : 400, { revoked: r.ok });
    }
    default:
      return json(400, { error: "unknown_action" });
  }
}
