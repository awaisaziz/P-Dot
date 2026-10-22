import type { Metadata, Viewport } from "next";
import { DM_Sans } from "next/font/google";
import Script from "next/script";
import { EARLY_INSTALL_SCRIPT, PwaSetup } from "@/features/pwa/PwaSetup";
import "./globals.css";
import "./styles/chat.css";
import "./styles/pages.css";

const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-dm-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "P-Dot",
  description: "A personal assistant for questions, research, writing, and planning.",
  applicationName: "P-Dot",
  appleWebApp: { capable: true, title: "P-Dot", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f4f7" },
    { media: "(prefers-color-scheme: dark)", color: "#14151a" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={dmSans.variable}>
      <body>
        <Script id="pwa-early-install" strategy="beforeInteractive">
          {EARLY_INSTALL_SCRIPT}
        </Script>
        <PwaSetup />
        {children}
      </body>
    </html>
  );
}
