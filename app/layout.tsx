import type { Metadata } from "next";
import { Big_Shoulders_Stencil, Familjen_Grotesk, Martian_Mono } from "next/font/google";
import "./globals.css";

const stencil = Big_Shoulders_Stencil({ subsets: ["latin"], weight: ["600", "800", "900"], variable: "--font-stencil", adjustFontFallback: false });
const mono = Martian_Mono({ subsets: ["latin"], weight: ["300", "400", "600"], variable: "--font-mono" });
const body = Familjen_Grotesk({ subsets: ["latin"], weight: ["400", "500", "700"], variable: "--font-body" });

export const metadata: Metadata = {
  title: "Drive Move-Out",
  description: "Transfer ownership of Google Drive folders between two personal accounts, in your browser.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${stencil.variable} ${mono.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
