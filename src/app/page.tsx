import type { Metadata } from "next";
import { HOME_TITLE, homeDescription } from "@/lib/home-seo";
import { pageMetadata } from "@/lib/page-metadata";
import { notaryAndStatePilotsEnabled } from "@/lib/sale-types";
import { organizationStructuredData } from "@/lib/seo";
import { resolveSiteOrigin } from "@/lib/site-url";
import { HomeHero } from "@/components/home/HomeHero";
import { HomeMotion } from "@/components/home/HomeMotion";
import { HomeOffers } from "@/components/home/HomeOffers";
import {
  HomeBenefits,
  HomeClosing,
  HomeFaq,
  homeFaqItems,
  HomeGuides,
  HomeSources,
  HomeStats,
  HomeSteps,
} from "@/components/home/HomeSections";
import { HomeTagline } from "@/components/home/HomeTagline";
import { HomeTryExample } from "@/components/home/HomeTryExample";
import { exampleVerdictData } from "@/lib/example-verdict";
import homeStyles from "@/components/home/HomePage.module.css";
import { loadHomeCatalogueSummary } from "@/lib/home-catalogue-summary.server";
import { loadHomeDepartmentCount } from "@/lib/home-departments.server";
import { ceilingTermText } from "@/lib/fee-regime-labels";
import { openFeeRegimesFromEnv } from "@/lib/fee-regime.server";
import { jsonLdString } from "@/lib/json-ld";
import { unlockHighlightsText } from "@/lib/sale-unlocks";

// Titre et description propres à l'accueil (voir `home-seo.ts`) ; calculés au rendu, comme la page,
// pour que les notaires et l'État ne soient cités que lorsque ces ventes sont au catalogue.
export function generateMetadata(): Metadata {
  return pageMetadata({
    path: "/",
    title: { absolute: HOME_TITLE },
    description: homeDescription(notaryAndStatePilotsEnabled()),
  });
}

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
  // Le terme du plafond des cartes d'offres suit l'interrupteur par régime (CEILING_FEE_REGIMES_OPEN).
  const openFeeRegimes = openFeeRegimesFromEnv();
  const ceilingTerm = ceilingTermText(openFeeRegimes);
  const origin = resolveSiteOrigin(process.env, "http://localhost:3000")!;
  const structuredData = organizationStructuredData(origin);
  const faqStructuredData = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: homeFaqItems(openFeeRegimes).map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  };
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLdString(structuredData),
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLdString(faqStructuredData),
        }}
      />
      <main id="contenu" className={homeStyles.page}>
        <HomeHero summary={summary} departments={departments} openFeeRegimes={openFeeRegimes} />
        <HomeStats summary={summary} departments={departments} />
        <HomeTryExample data={exampleVerdictData()} />
        <HomeTagline />
        <HomeBenefits />
        <HomeSteps />
        <HomeSources />
        <HomeGuides />
        <HomeOffers
          unlockHighlights={unlockHighlightsText(openFeeRegimes)}
          ceilingFeature={`${ceilingTerm.charAt(0).toUpperCase()}${ceilingTerm.slice(1)} et travaux`}
        />
        <HomeFaq openFeeRegimes={openFeeRegimes} />
        <HomeClosing summary={summary} departments={departments} />
        <HomeMotion />
      </main>
    </>
  );
}
