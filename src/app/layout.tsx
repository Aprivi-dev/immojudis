import type { Metadata } from "next";
import { Cormorant_Garamond, IBM_Plex_Sans } from "next/font/google";
import "./../styles.css";
import { AppProviders } from "./providers";

const cormorantGaramond = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-cormorant-garamond",
});

const ibmPlexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-ibm-plex-sans",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://immojudis-dezt.vercel.app"),
  title: {
    default: "Immojudis - Rapports d'opportunite pour ventes judiciaires",
    template: "%s - Immojudis",
  },
  description:
    "Rapports d'opportunite, annonces analysees, alertes et mise maximale pour encheres immobilieres judiciaires.",
  authors: [{ name: "Immojudis" }],
  icons: {
    icon: "/brand/immojudis-justice-temple.svg",
    apple: "/brand/immojudis-justice-temple.svg",
  },
  openGraph: {
    title: "Immojudis - Rapports d'opportunite pour ventes judiciaires",
    description:
      "Annonces analysees, comparables DVF, alertes et mise maximale pour les encheres immobilieres judiciaires.",
    type: "website",
    url: "https://immojudis-dezt.vercel.app",
  },
  twitter: {
    card: "summary",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className={`${cormorantGaramond.variable} ${ibmPlexSans.variable}`}>
      <body>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
