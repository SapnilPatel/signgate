import { ImageResponse } from "next/og";
import { PRODUCT_NAME } from "@/lib/env";

export const alt = `${PRODUCT_NAME}: your client agreement, signed on every file`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/*
 * A sheet of paper with one signature line and its yellow flag. Uses the image
 * renderer's built-in typeface: fetching the site fonts here would make every
 * link preview depend on a network call. The flag is an SVG path because the
 * renderer has no clip-path.
 */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#eef1f4", padding: 56 }}>
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            background: "#ffffff",
            border: "2px solid #d5dbe3",
            borderRadius: 16,
            padding: "56px 64px",
            color: "#16233b",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", fontSize: 36, fontWeight: 700 }}>
            <svg width="44" height="24" viewBox="0 0 22 12" style={{ marginRight: 16 }}>
              <path d="M0 0h22v12H0l6-6z" fill="#ffd23f" />
            </svg>
            {PRODUCT_NAME}
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", fontSize: 68, fontWeight: 700, lineHeight: 1.08, letterSpacing: -1.5, maxWidth: 900 }}>
              Your client agreement, signed on every file.
            </div>
            <div style={{ display: "flex", alignItems: "flex-end", marginTop: 56 }}>
              <div style={{ display: "flex", width: 560, borderBottom: "4px solid #16233b" }} />
              <div style={{ display: "flex", position: "relative", marginLeft: 20, width: 230, height: 60 }}>
                <svg width="230" height="60" viewBox="0 0 230 60" style={{ position: "absolute", top: 0, left: 0 }}>
                  <path d="M0 0h230v60H0l22-30z" fill="#ffd23f" />
                </svg>
                <div
                  style={{
                    display: "flex",
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: 230,
                    height: 60,
                    alignItems: "center",
                    justifyContent: "center",
                    paddingLeft: 18,
                    fontSize: 30,
                    fontWeight: 700,
                    color: "#4a3a00",
                  }}
                >
                  Sign here
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    ),
    size,
  );
}
