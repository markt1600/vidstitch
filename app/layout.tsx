import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "File Utilities — private video, audio & sharing tools",
  description:
    "Private, self-destructing file tools: stitch MP4 videos together, compress video, make GIFs, resize images in-browser, share files via expiring links, and extract MP3 clips. Everything is deleted within 5 minutes.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        {/* Same families as marktan.ai: Fraunces display, Newsreader body,
            JetBrains Mono details. */}
        <link
          href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;0,9..144,800;1,9..144,400;1,9..144,500&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400;1,6..72,500&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
