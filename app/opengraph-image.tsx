import { ImageResponse } from "next/og";

export const alt = "Drive Move-Out: transfer ownership of a Google Drive folder to another account";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** The app's stencil font as TTF from Google Fonts (fetched at build time); falls back to the default font. */
async function stencil(): Promise<ArrayBuffer | null> {
  try {
    const css = await (await fetch("https://fonts.googleapis.com/css2?family=Big+Shoulders+Stencil:wght@900")).text();
    const url = css.match(/url\((https:[^)]+\.ttf)\)/)?.[1];
    return url ? await (await fetch(url)).arrayBuffer() : null;
  } catch {
    return null;
  }
}

// Social preview card in the app's shipping-label style
export default async function Image() {
  const font = await stencil();
  const title = { fontSize: 150, fontWeight: 900, lineHeight: 0.85, ...(font ? { fontFamily: "Stencil" } : {}) } as const;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between",
                    padding: 64, background: "#d8bf96", color: "#1e1a15", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={title}>DRIVE</div>
          <div style={{ ...title, color: "#e2541b" }}>MOVE-OUT</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ fontSize: 44, fontWeight: 700, lineHeight: 1.15 }}>
            Transfer ownership of a Google Drive folder, and everything in it, to another account
          </div>
          <div style={{ display: "flex", gap: 16, fontSize: 26 }}>
            {["No re-uploading", "Resumable", "Runs in your browser", "Open source"].map(t => (
              <div key={t} style={{ display: "flex", border: "3px solid #1e1a15", padding: "6px 14px", background: "#f4ead6" }}>{t}</div>
            ))}
          </div>
        </div>
      </div>
    ),
    font ? { ...size, fonts: [{ name: "Stencil", data: font, weight: 900, style: "normal" }] } : size,
  );
}
