import type { Metadata } from "next";
import { connection } from "next/server";
import localFont from "next/font/local";
import "./../styles.css";
import { AppProviders } from "./providers";
import { AudienceMeasurement } from "@/components/AudienceMeasurement";
import { DeferredGoogleAnalytics } from "@/components/DeferredGoogleAnalytics";
import { SkipLink } from "@/components/SkipLink";
import { COMPANY_DESCRIPTION } from "@/lib/company-description";
import { cspRequiresDynamicRendering } from "@/lib/security-headers";
import { resolveSiteOrigin } from "@/lib/site-url";

// Police auto-hébergée dans src/fonts/ (voir le README du dossier) : le build ne télécharge rien
// depuis Google Fonts. Manrope, seule police du site (décision du 25/10/2026, à la place de
// Cormorant Garamond et d'IBM Plex Sans) : fichier WOFF2 « latin » variable, chaque graisse listée
// réutilise le même fichier (un seul téléchargement). Un @font-face par graisse employée.
// Les options de `next/font` doivent être des littéraux : pas de variable ni de fonction ici.
const manrope = localFont({
  src: [
    { path: "../fonts/manrope-latin.woff2", weight: "400", style: "normal" },
    { path: "../fonts/manrope-latin.woff2", weight: "500", style: "normal" },
    { path: "../fonts/manrope-latin.woff2", weight: "600", style: "normal" },
    { path: "../fonts/manrope-latin.woff2", weight: "700", style: "normal" },
    { path: "../fonts/manrope-latin.woff2", weight: "800", style: "normal" },
  ],
  display: "swap",
  variable: "--font-manrope",
  // Préchargée : tout le texte du premier écran s'affiche avec cette police.
  preload: true,
  // Police de secours ajustée (size-adjust, ascent/descent) calculée sur le fichier de la police,
  // comme le faisait `next/font/google` : limite le décalage de mise en page au remplacement.
  adjustFontFallback: "Arial",
  // Sous-ensemble latin uniquement, comme avec `subsets: ["latin"]`.
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
});

const siteOrigin = resolveSiteOrigin(process.env, "http://localhost:3000")!;

export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin),
  title: {
    default: "Immojudis - Les enchères immobilières en toute clarté",
    template: "%s - Immojudis",
  },
  description: COMPANY_DESCRIPTION,
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
    description: COMPANY_DESCRIPTION,
    type: "website",
    // Pas d'`url` ici : cet objet est hérité par toutes les pages, et fixer l'accueil comme
    // adresse Open Graph de chacune d'elles serait faux. Chaque page pose la sienne.
    siteName: "Immojudis",
    locale: "fr_FR",
  },
  twitter: {
    card: "summary_large_image",
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // A nonce can only be stamped on scripts at request time. Enforcing the strict CSP (or
  // previewing it with CSP_NONCE_DYNAMIC=true) therefore renders every page dynamically; by
  // default the proxy sends no strict policy at all and static pages stay static.
  if (cspRequiresDynamicRendering()) await connection();
  return (
    <html lang="fr" className={manrope.variable}>
      <body>
        <SkipLink />
        <AppProviders>{children}</AppProviders>
        <AudienceMeasurement />
        <DeferredGoogleAnalytics />
      </body>
    </html>
  );
}
