import type { Metadata } from "next";
import { AuthGate } from "@/components/AuthGate";
import { RightsPage } from "./rights-page";

export const metadata: Metadata = {
  title: "Mes droits",
  description: "Exercer un droit sur ses données personnelles ou demander une rétractation.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <AuthGate>
      <RightsPage />
    </AuthGate>
  );
}
