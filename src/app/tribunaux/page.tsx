import type { Metadata } from "next";
import { AuthGate } from "@/components/AuthGate";
import { TribunalsPage } from "@/routes/tribunaux";

export const metadata: Metadata = {
  title: "Statistiques par tribunal",
  description:
    "Analyse descriptive des audiences et résultats judiciaires vérifiés, avec couverture et niveau de fiabilité visibles.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <AuthGate>
      <TribunalsPage />
    </AuthGate>
  );
}
