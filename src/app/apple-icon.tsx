import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/*
 * The sign-here flag on ink, matching icon.svg. Drawn as an SVG path because the
 * image renderer does not support clip-path, which is how the flag is cut in CSS.
 * iOS rounds the corners itself, so the background runs to the edge.
 */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#16233b" }}>
        <svg width="124" height="68" viewBox="0 0 22 12">
          <path d="M0 0h22v12H0l6-6z" fill="#ffd23f" />
        </svg>
      </div>
    ),
    size,
  );
}
