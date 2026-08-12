import type { Metadata } from "next";
import { Roboto, Orbitron } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

// Font variables mirror ape-church's app/layout.tsx exactly (--font-body /
// --font-heading / --font-orbitron). The ported game CSS keys off them:
// stuntman-chris.css builds --sc-display from var(--font-orbitron) with
// var(--font-heading) as the fallback, and components/ui/card.tsx's
// `font-display` resolves to --font-heading via @theme inline in globals.css.
const roboto = Roboto({
  variable: "--font-body",
  subsets: ["latin"],
  display: "swap",
});

const nohemi = localFont({
  src: "./fonts/Nohemi/Variable-TT/Nohemi-VF.ttf",
  variable: "--font-heading",
  display: "swap",
});

const orbitron = Orbitron({
  variable: "--font-orbitron",
  subsets: ["latin"],
  weight: ["700", "900"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Stuntman Chris",
  description: "Stuntman Chris — standalone build",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${roboto.variable} ${nohemi.variable} ${orbitron.variable} font-sans antialiased`}
      >
        {/* Stands in for the platform's ContentFrame. GameHudPage's lg:-mt-14 /
            lg:-mx-6 are measured against these paddings — keep them in sync
            with ape-church if the frame ever looks off. */}
        <div className="container mx-auto px-4 lg:px-12 pt-8 pb-6 sm:pt-12 sm:pb-16 md:pt-20 md:pb-32">
          {children}
        </div>
      </body>
    </html>
  );
}
