import type { Metadata } from "next";
import { PublicTribunalActivitySection } from "@/components/PublicTribunalActivity";
import { TribunalJudicialActivityExplorer } from "@/components/TribunalJudicialActivityExplorer";
import { loadPublicTribunalActivity } from "@/lib/public-tribunal-activity.server";

/**
 * The adjudication prices (Licitor results) are announced only once the statistics are open.
 * Same switch as the sale page and `getAdjudicationPriceStatisticsForSale`.
 */
function adjudicationStatisticsEnabled(): boolean {
  return process.env.ADJUDICATION_PRICE_STATISTICS_ENABLED === "true";
}

export async function generateMetadata(): Promise<Metadata> {
  const publicActivity = await loadPublicTribunalActivity();
  const adjudication = adjudicationStatisticsEnabled();
  return {
    title: "Ventes judiciaires à venir par tribunal",
    description: adjudication
      ? "Ventes judiciaires à venir, prochaines audiences et mises à prix tribunal par tribunal ; prix d’adjudication et résultats avec l’offre Analyse."
      : "Ventes judiciaires à venir, prochaine audience et mise à prix médiane des biens annoncés, tribunal judiciaire par tribunal judiciaire.",
    alternates: { canonical: "/tribunaux" },
    // Without any court to list the page has nothing of its own to offer a search engine.
    robots:
      publicActivity.length > 0 ? { index: true, follow: true } : { index: false, follow: true },
  };
}

export default async function Page() {
  const publicActivity = await loadPublicTribunalActivity();
  const adjudication = adjudicationStatisticsEnabled();
  return (
    <TribunalJudicialActivityExplorer
      adjudicationStatisticsEnabled={adjudication}
      publicActivity={
        <PublicTribunalActivitySection
          items={publicActivity}
          adjudicationStatisticsEnabled={adjudication}
        />
      }
    />
  );
}
