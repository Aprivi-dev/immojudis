import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Cormorant_Garamond, IBM_Plex_Sans } from "next/font/google";
import "./../styles.css";
import { AppProviders } from "./providers";
import { SkipLink } from "@/components/SkipLink";
import { resolveSiteOrigin } from "@/lib/site-url";

const cormorantGaramond = Cormorant_Garamond({
  subsets: ["latin"],
  // Seules les graisses réellement employées par font-display : 400 (dont l'italique des
  // accents de titre), 500 et 600. Les graisses 300 et 700 ne sont jamais demandées.
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-cormorant-garamond",
  preload: false,
});

const ibmPlexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-ibm-plex-sans",
});

const siteOrigin = resolveSiteOrigin(process.env, "http://localhost:3000")!;

export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin),
  title: {
    default: "Immojudis - Les enchères immobilières en toute clarté",
    template: "%s - Immojudis",
  },
  description:
    "Tribunal, notaire ou État : annonces immobilières référencées, procédures expliquées et analyses pour préparer votre achat.",
  authors: [{ name: "Immojudis" }],
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/brand/immojudis-justice-temple.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  openGraph: {
    title: "Immojudis - Les enchères immobilières en toute clarté",
    description:
      "Ventes au tribunal, notariales et domaniales référencées : comprenez les règles et préparez votre achat avec Immojudis.",
    type: "website",
    url: siteOrigin,
    siteName: "Immojudis",
    locale: "fr_FR",
  },
  twitter: {
    card: "summary_large_image",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className={`${cormorantGaramond.variable} ${ibmPlexSans.variable}`}>
      <body>
        <SkipLink />
        <AppProviders>{children}</AppProviders>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
