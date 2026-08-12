import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VidStitch — private MP4 merger",
  description:
    "Stitch up to 6 MP4 files into one. Sources are deleted on merge; the merged file self-destructs after 5 minutes.",
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
