import type { Metadata } from "next";
import { organizationStructuredData } from "@/lib/seo";
import { resolveSiteOrigin } from "@/lib/site-url";
import { CinematicHero } from "@/components/CinematicHome";
import { HomeDiscovery } from "@/components/HomeDiscovery";
import { loadHomeCatalogueSummary } from "@/lib/home-catalogue-summary.server";
import { jsonLdString } from "@/lib/json-ld";
import { cormorantGaramond as cormorantGaramondItalic } from "@/fonts/cormorant-garamond-italic-preloaded";

export const metadata: Metadata = {
  title: { absolute: "Immojudis - Les enchères immobilières en toute clarté" },
  description:
    "Ventes au tribunal, notariales et domaniales référencées : distinguez les procédures, trouvez une annonce et préparez votre achat immobilier.",
  alternates: { canonical: "/" },
};

// La page est générée à l'avance puis rafraîchie par Next.js : sans valeur explicite, un rendu fait
// pendant une panne (ligne de chiffres absente) resterait jusqu'au prochain déploiement.
// 5 minutes, comme la première page du catalogue (FIRST_PAGE_REVALIDATE_SECONDS) ; Next.js veut
// ici un littéral.
export const revalidate = 300;

export default async function Page() {
  const summary = await loadHomeCatalogueSummary();
  const origin = resolveSiteOrigin(process.env, "http://localhost:3000")!;
  const structuredData = organizationStructuredData(origin);
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLdString(structuredData),
        }}
      />
      {/* `.variable` seul : il rattache le préchargement de l'italique du h1 à cette route. */}
      <main
        id="contenu"
        className={`ij-page ij-cinematic-page ${cormorantGaramondItalic.variable}`}
      >
        <CinematicHero summary={summary} />
        <HomeDiscovery />
      </main>
    </>
  );
}
