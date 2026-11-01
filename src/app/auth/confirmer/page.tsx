import type { Metadata } from "next";
import { AuthLinkConfirmation } from "@/components/AuthLinkConfirmation";

export const metadata: Metadata = {
  title: "Confirmer votre email",
  robots: { index: false, follow: false },
  // Le jeton du lien est dans l'adresse : aucune page ouverte depuis celle-ci n'en reçoit l'origine.
  referrer: "no-referrer",
};

export default function Page() {
  return <AuthLinkConfirmation />;
}
