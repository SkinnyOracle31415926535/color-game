import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Color Game",
  applicationName: "Color Game",
  description: "Private gymnastics color and position warmup game.",
  manifest: "/legacy/site.webmanifest",
  icons: {
    icon: [
      { url: "/legacy/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/legacy/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/legacy/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    shortcut: "/legacy/favicon-32.png",
    apple: [{ url: "/legacy/icon-180.png", sizes: "180x180", type: "image/png" }],
  },
  other: {
    "apple-mobile-web-app-capable": "yes",
  },
  appleWebApp: {
    capable: true,
    title: "Color Game",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#0033ff",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
