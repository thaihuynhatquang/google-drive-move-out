import type { Metadata } from "next";
import { Big_Shoulders_Stencil, Familjen_Grotesk, Martian_Mono } from "next/font/google";
import { SITE_DESCRIPTION, SITE_TITLE, SITE_URL } from "@/lib/site";
import "./globals.css";

const stencil = Big_Shoulders_Stencil({ subsets: ["latin"], weight: ["600", "800", "900"], variable: "--font-stencil", adjustFontFallback: false });
const mono = Martian_Mono({ subsets: ["latin"], weight: ["300", "400", "600"], variable: "--font-mono" });
const body = Familjen_Grotesk({ subsets: ["latin"], weight: ["400", "500", "700"], variable: "--font-body" });

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: SITE_TITLE, template: "%s · Drive Move-Out" },
  description: SITE_DESCRIPTION,
  applicationName: "Drive Move-Out",
  keywords: ["transfer ownership Google Drive", "Google Drive transfer ownership folder", "move Google Drive files to another account",
             "change owner Google Drive", "Gmail account migration", "Google Drive storage", "bulk transfer ownership"],
  alternates: { canonical: "/" },
  openGraph: { type: "website", url: "/", siteName: "Drive Move-Out", title: SITE_TITLE, description: SITE_DESCRIPTION },
  twitter: { card: "summary_large_image", title: SITE_TITLE, description: SITE_DESCRIPTION },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${stencil.variable} ${mono.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
