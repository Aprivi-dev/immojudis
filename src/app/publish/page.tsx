import type { Metadata } from "next";
import { AuthGate } from "@/components/AuthGate";
import { PublishPage } from "./publish-page";

export const metadata: Metadata = {
  title: "Publier une vente",
  description:
    "Préparez une demande de publication de vente aux enchères immobilière avec documents et validation par l’équipe Immojudis.",
};

export default function Page() {
  return (
    <AuthGate>
      <PublishPage />
    </AuthGate>
  );
}
