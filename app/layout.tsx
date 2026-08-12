import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "File Utilities — private video, audio & sharing tools",
  description:
    "Private, self-destructing file tools: stitch MP4 videos together, share files via expiring links, and extract MP3 clips. Everything is deleted within 5 minutes.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
