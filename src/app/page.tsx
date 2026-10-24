import type { Metadata } from "next";
import { COMPANY_DESCRIPTION } from "@/lib/company-description";
import { organizationStructuredData } from "@/lib/seo";
import { resolveSiteOrigin } from "@/lib/site-url";
import { HomeHero } from "@/components/home/HomeHero";
import { HomeMotion } from "@/components/home/HomeMotion";
import { HomeOffers } from "@/components/home/HomeOffers";
import { HomeClosing, HomeFeatures, HomeJourney, HomeStats } from "@/components/home/HomeSections";
import homeStyles from "@/components/home/HomePage.module.css";
import { loadHomeCatalogueSummary } from "@/lib/home-catalogue-summary.server";
import { loadHomeDepartmentCount } from "@/lib/home-departments.server";
import { jsonLdString } from "@/lib/json-ld";
import { PreloadCormorantItalic } from "@/components/PreloadCormorantItalic";

export const metadata: Metadata = {
  title: { absolute: "Immojudis - Les enchères immobilières en toute clarté" },
  description: COMPANY_DESCRIPTION,
  alternates: { canonical: "/" },
};

// La page est générée à l'avance puis rafraîchie par Next.js : sans valeur explicite, un rendu fait
// pendant une panne (ligne de chiffres absente) resterait jusqu'au prochain déploiement.
// 5 minutes, comme la première page du catalogue (FIRST_PAGE_REVALIDATE_SECONDS) ; Next.js veut
// ici un littéral.
export const revalidate = 300;

export default async function Page() {
  const [summary, departments] = await Promise.all([
    loadHomeCatalogueSummary(),
    loadHomeDepartmentCount(),
  ]);
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
      {/* L'italique du h1 (accent « clarté. ») est préchargée par cette page seule. */}
      <PreloadCormorantItalic />
      <main id="contenu" className={`ij-page ${homeStyles.page}`}>
        <HomeHero summary={summary} />
        <HomeStats summary={summary} departments={departments} />
        <HomeJourney />
        <HomeFeatures />
        <HomeOffers />
        <HomeClosing />
        <HomeMotion />
      </main>
    </>
  );
}
