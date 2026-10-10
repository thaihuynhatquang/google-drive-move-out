"use client";
// Google redirects here after sign-in: finish the login, then go back to the main page.
import { useEffect, useRef } from "react";
import { finishLogin, session } from "@/lib/auth";

export default function Callback() {
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;  // the code is single-use (dev StrictMode runs effects twice)
    ran.current = true;
    const q = new URLSearchParams(location.search);
    history.replaceState(null, "", location.pathname);  // drop the code from the URL / history
    finishLogin(q).then(msg => {
      session.flash(msg);
      location.replace("/");
    });
  }, []);

  return <p style={{ padding: "40px 16px", margin: 0 }}>Finishing sign-in…</p>;
}
