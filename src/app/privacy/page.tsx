import type { Metadata } from "next";
import { PrivacyPage } from "@/routes/privacy";

export const metadata: Metadata = {
  alternates: { canonical: "/privacy" },
  title: "Confidentialité",
  description: "Politique de confidentialité Immojudis.",
};

export default function Page() {
  return <PrivacyPage />;
}
