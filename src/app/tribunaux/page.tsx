import type { Metadata } from "next";
import { BreadcrumbJsonLd } from "@/components/BreadcrumbJsonLd";
import { PublicTribunalActivitySection } from "@/components/PublicTribunalActivity";
import { TribunalJudicialActivityExplorer } from "@/components/TribunalJudicialActivityExplorer";
import { TribunalSectorAlert } from "@/components/TribunalSectorAlert";
import { pageMetadata } from "@/lib/page-metadata";
import { loadPublicTribunalActivity } from "@/lib/public-tribunal-activity.server";

/**
 * The adjudication prices (Licitor results) are announced only once the statistics are open.
 * Same switch as the sale page and `getAdjudicationPriceStatisticsForSale`.
 */
function adjudicationStatisticsEnabled(): boolean {
  return process.env.ADJUDICATION_PRICE_STATISTICS_ENABLED === "true";
}

// The page is rendered ahead of time and then refreshed by Next.js. Without an explicit value a
// render made during an outage (empty list, no figures) would be kept until the next deploy.
// 5 minutes: same delay as PUBLIC_TRIBUNAL_ACTIVITY_FAILURE_RETRY_MS (a test checks it; Next.js
// wants a literal here). The courts themselves stay cached for an hour in the data cache.
export const revalidate = 300;

export async function generateMetadata(): Promise<Metadata> {
  const activity = await loadPublicTribunalActivity();
  const adjudication = adjudicationStatisticsEnabled();
  return {
    ...pageMetadata({
      path: "/tribunaux",
      title: "Ventes judiciaires à venir par tribunal",
      description: adjudication
        ? "Ventes judiciaires à venir, prochaines audiences et mises à prix tribunal par tribunal ; prix d’adjudication et résultats avec l’offre Analyse, pour les tribunaux à l’historique suffisant."
        : "Ventes judiciaires à venir, prochaine audience et mise à prix médiane des biens annoncés, tribunal judiciaire par tribunal judiciaire.",
    }),
    // Without any court to list the page has nothing of its own to offer a search engine. A read
    // error says nothing about the courts: the page stays indexable, and the short `revalidate`
    // above keeps that render from lasting.
    robots:
      activity.status === "ok" && activity.items.length === 0
        ? { index: false, follow: true }
        : { index: true, follow: true },
  };
}

export default async function Page() {
  const activity = await loadPublicTribunalActivity();
  const publicActivity = activity.status === "ok" ? activity.items : [];
  const adjudication = adjudicationStatisticsEnabled();
  return (
    <>
      <BreadcrumbJsonLd trail={[{ name: "Tribunaux", path: "/tribunaux" }]} />
      <TribunalJudicialActivityExplorer
        adjudicationStatisticsEnabled={adjudication}
        publicActivity={
          <>
            <PublicTribunalActivitySection
              items={publicActivity}
              adjudicationStatisticsEnabled={adjudication}
            />
            <TribunalSectorAlert />
          </>
        }
      />
    </>
  );
}
