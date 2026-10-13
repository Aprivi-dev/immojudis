import type { Metadata } from "next";
import { connection } from "next/server";
import { Cormorant_Garamond, IBM_Plex_Sans } from "next/font/google";
import "./../styles.css";
import { AppProviders } from "./providers";
import { AudienceMeasurement } from "@/components/AudienceMeasurement";
import { SkipLink } from "@/components/SkipLink";
import { cspRequiresDynamicRendering } from "@/lib/security-headers";
import { resolveSiteOrigin } from "@/lib/site-url";

const cormorantGaramond = Cormorant_Garamond({
  subsets: ["latin"],
  // Seules les graisses réellement employées par font-display : 400 (dont l'italique des
  // accents de titre), 500 et 600. Les graisses 300 et 700 ne sont jamais demandées. Le h1 de
  // l'accueil n'emploie que 500 et l'italique 400, mais 600 sert à d'autres titres : on ne
  // réduit pas la liste. Cela ne coûte rien au préchargement : Google sert une police variable,
  // donc un seul fichier par style (normal et italique), quelles que soient les graisses.
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-cormorant-garamond",
  // Préchargée : le h1 de l'accueil s'affiche avec cette police, qui sinon n'est demandée
  // qu'après le calcul des styles (changement visible à l'affichage, `display: swap`).
  preload: true,
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
  // previewing it with CSP_NONCE_DYNAMIC=true) therefore renders every page dynamically; in the
  // default report-only mode static pages stay static and only report.
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
