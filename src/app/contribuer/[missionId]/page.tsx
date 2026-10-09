import type { Metadata } from "next";
import { InformationAgentContributionForm } from "@/components/information-agent/InformationAgentContributionForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Transmettre des informations",
  description: "Déposer une réponse ou des pièces dans un espace privé Immojudis.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function ContributionPage({
  params,
}: {
  params: Promise<{ missionId: string }>;
}) {
  const { missionId } = await params;
  return <InformationAgentContributionForm missionId={missionId} />;
}
