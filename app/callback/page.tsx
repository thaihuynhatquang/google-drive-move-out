"use client";
// OAuth redirect target: hand the code to the app tab, then close.
// BroadcastChannel instead of window.opener: Google's login pages cut the opener link.
import { useEffect, useState } from "react";

export default function Callback() {
  const [msg, setMsg] = useState("Finishing login…");

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const ch = new BroadcastChannel("oauth");
    ch.postMessage({ state: q.get("state"), code: q.get("code"), error: q.get("error") });
    ch.close();
    history.replaceState(null, "", location.pathname);  // drop the code from the URL / history
    setMsg(q.get("code") ? "Logged in. You can close this window." : `Login failed: ${q.get("error")}`);
    const t = setTimeout(() => window.close(), 300);
    return () => clearTimeout(t);
  }, []);

  return <p style={{ padding: "40px 16px", margin: 0 }}>{msg}</p>;
}
