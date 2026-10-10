"use client";
// Google redirects here after sign-in: finish the login, then go back to the main page.
import { useEffect, useRef, useState } from "react";
import { finishLogin, session } from "@/lib/auth";

export default function Callback() {
  const ran = useRef(false);
  const [slow, setSlow] = useState(false);
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    if (ran.current) return;  // the code is single-use (dev StrictMode runs effects twice)
    ran.current = true;
    const q = new URLSearchParams(location.search);
    history.replaceState(null, "", location.pathname);  // drop the code from the URL / history
    const t = setTimeout(() => setSlow(true), 12_000);
    finishLogin(q).then(msg => {
      clearTimeout(t);
      setResult(msg);
      session.flash(msg);
      setTimeout(() => location.replace("/"), msg.ok ? 600 : 1800);
    });
    return () => clearTimeout(t);
  }, []);

  const failed = result && !result.ok;
  return (
    <main className="cb">
      <section className={"label cb-card" + (failed ? " cb-failed" : "")} aria-live="polite">
        <div className="label-head">Sign-in <small>Drive Move-Out</small></div>
        <div className="cb-body">
          <h1 className="cb-title">
            {!result ? "Checking in…" : result.ok ? "You're in" : "Sign-in failed"}
          </h1>
          <p className="cb-text">
            {result ? result.text
              : slow ? "Google is taking longer than usual. You can wait a little more, or go back and try again."
              : "Confirming your Google account. You'll be back on the shipping label in a moment."}
          </p>
          <div className={"conveyor cb-belt" + (result ? "" : " moving")} aria-hidden="true">
            <div className="fill" style={{ width: result ? "100%" : "62%" }} />
          </div>
          {(slow || result) && <a className="cb-back" href="/">← Back to the app</a>}
        </div>
      </section>
    </main>
  );
}
