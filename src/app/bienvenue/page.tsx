import type { Metadata } from "next";
import { AuthGate } from "@/components/AuthGate";
import { InvestorOnboarding } from "@/components/InvestorOnboarding";
import { ONBOARDING_RETURN_PARAM, saleDetailReturnPath } from "@/lib/onboarding";

export const metadata: Metadata = {
  title: "Votre première recherche",
  description: "Préparer votre première recherche de vente immobilière avec Immojudis.",
  robots: { index: false, follow: false },
};

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const returnParam = (await searchParams)[ONBOARDING_RETURN_PARAM];
  // Une seule fiche du site, reconstruite : jamais une adresse reçue telle quelle.
  const returnTo = saleDetailReturnPath(Array.isArray(returnParam) ? returnParam[0] : returnParam);
  return (
    <AuthGate>
      <InvestorOnboarding returnTo={returnTo} />
    </AuthGate>
  );
}
