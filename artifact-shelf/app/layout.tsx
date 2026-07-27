import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const viewport: Viewport = {
  themeColor: "#000000",
  colorScheme: "dark",
};

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    title: "Artifact Shelf · Chatinabox",
    description:
      "A Telegram Mini App for reopening artifacts made in one session.",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title: "Artifact Shelf",
      description: "One Telegram session. Many reusable outputs.",
      images: [`${origin}/og-v2.png`],
    },
    twitter: {
      card: "summary_large_image",
      title: "Artifact Shelf",
      description: "One Telegram session. Many reusable outputs.",
      images: [`${origin}/og-v2.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        {/* `viewport-fit=cover` is what makes env(safe-area-inset-*) resolve
            inside Telegram's WebView, where the shell floats over the notch
            and the home indicator. vinext does not emit it from the viewport
            export, so it is declared here and wins by document order. */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        <script src="https://telegram.org/js/telegram-web-app.js?63" />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
