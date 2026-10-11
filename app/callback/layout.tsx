import type { Metadata } from "next";

// OAuth hand-off page: keep it out of search results
export const metadata: Metadata = { title: "Signing in", robots: { index: false, follow: false } };

export default function CallbackLayout({ children }: { children: React.ReactNode }) {
  return children;
}
