import type { Metadata } from "next";
import { PublicTribunalActivitySection } from "@/components/PublicTribunalActivity";
import { TribunalJudicialActivityExplorer } from "@/components/TribunalJudicialActivityExplorer";
import { loadPublicTribunalActivity } from "@/lib/public-tribunal-activity.server";

export const metadata: Metadata = {
  title: "Statistiques Tribunaux",
  description:
    "Ventes judiciaires à venir, prochaines audiences et mises à prix tribunal par tribunal ; prix d’adjudication et résultats avec l’offre Analyse.",
  alternates: { canonical: "/tribunaux" },
  robots: { index: true, follow: true },
};

export default async function Page() {
  const publicActivity = await loadPublicTribunalActivity();
  return (
    <TribunalJudicialActivityExplorer
      publicActivity={<PublicTribunalActivitySection items={publicActivity} />}
    />
  );
}
