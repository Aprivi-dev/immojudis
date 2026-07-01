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
    default: "Immojudis - Ventes immobilieres judiciaires",
    template: "%s - Immojudis",
  },
  description:
    "Explorez les ventes aux encheres immobilieres judiciaires avec annonces analysees, alertes et mise plafond.",
  authors: [{ name: "Immojudis" }],
  icons: {
    icon: "/brand/immojudis-justice-temple.svg",
    apple: "/brand/immojudis-justice-temple.svg",
  },
  openGraph: {
    title: "Immojudis - Ventes immobilieres judiciaires",
    description:
      "Annonces analysees, alertes et mise plafond pour les encheres immobilieres judiciaires.",
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
