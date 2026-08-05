import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Color Game",
  description: "Private gymnastics color and position warmup game.",
  manifest: "/legacy/site.webmanifest",
  icons: {
    icon: "/legacy/favicon-32.png",
    apple: "/legacy/icon-180.png",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
