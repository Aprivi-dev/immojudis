import type { Metadata } from "next";
import { connection } from "next/server";
import localFont from "next/font/local";
import "./../styles.css";
import { AppProviders } from "./providers";
import { AudienceMeasurement } from "@/components/AudienceMeasurement";
import { SkipLink } from "@/components/SkipLink";
import { cspRequiresDynamicRendering } from "@/lib/security-headers";
import { resolveSiteOrigin } from "@/lib/site-url";

// Polices auto-hébergées dans src/fonts/ (voir le README du dossier) : le build ne télécharge plus
// rien depuis Google Fonts. Ce sont les fichiers WOFF2 « latin » que servait `next/font/google`.
// Ils sont variables : chaque graisse listée réutilise le même fichier (un seul téléchargement
// par style). On garde un @font-face par graisse, comme le CSS généré auparavant, et non une plage
// « 400 600 » : les graisses intermédiaires du CSS (550, 650, 750…) retombent ainsi sur la même
// graisse déclarée qu'avant, sans changement de rendu.
// Les options de `next/font` doivent être des littéraux : pas de variable ni de fonction ici.
const cormorantGaramond = localFont({
  src: [
    // Seules les graisses réellement employées par font-display : 400, 500 et 600 (les graisses
    // 300 et 700 ne sont jamais demandées). Le h1 de l'accueil n'emploie que 500 et l'italique 400,
    // mais 600 sert à d'autres titres : on ne réduit pas la liste.
    // L'italique (mêmes graisses) est déclarée à part, par des `@font-face` de `src/styles.css`,
    // sous le même nom de famille : `next/font` précharge tous les fichiers d'une même déclaration,
    // et l'italique ne sert au premier écran que sur l'accueil et /ressources.
    { path: "../fonts/cormorant-garamond-latin-normal.woff2", weight: "400", style: "normal" },
    { path: "../fonts/cormorant-garamond-latin-normal.woff2", weight: "500", style: "normal" },
    { path: "../fonts/cormorant-garamond-latin-normal.woff2", weight: "600", style: "normal" },
  ],
  display: "swap",
  variable: "--font-cormorant-garamond",
  // Préchargée : le h1 de l'accueil s'affiche avec cette police, qui sinon n'est demandée
  // qu'après le calcul des styles (changement visible à l'affichage, `display: swap`). Seul le
  // fichier des graisses normales l'est ici ; l'italique l'est par les pages qui l'affichent au
  // premier écran (`src/components/PreloadCormorantItalic.tsx`).
  preload: true,
  // Police de secours ajustée (size-adjust, ascent/descent) calculée sur le fichier de la police,
  // comme le faisait `next/font/google` : limite le décalage de mise en page au remplacement.
  adjustFontFallback: "Times New Roman",
  // Sous-ensemble latin uniquement, comme avec `subsets: ["latin"]`.
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
});

const ibmPlexSans = localFont({
  src: [
    { path: "../fonts/ibm-plex-sans-latin.woff2", weight: "400", style: "normal" },
    { path: "../fonts/ibm-plex-sans-latin.woff2", weight: "500", style: "normal" },
    { path: "../fonts/ibm-plex-sans-latin.woff2", weight: "600", style: "normal" },
    { path: "../fonts/ibm-plex-sans-latin.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
  variable: "--font-ibm-plex-sans",
  preload: true,
  adjustFontFallback: "Arial",
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
    <html lang="fr" className={`${cormorantGaramond.variable} ${ibmPlexSans.variable}`}>
      <body>
        <SkipLink />
        <AppProviders>{children}</AppProviders>
        <AudienceMeasurement />
      </body>
    </html>
  );
}
