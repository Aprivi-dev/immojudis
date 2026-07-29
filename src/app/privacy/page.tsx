import type { Metadata } from "next";
import { PrivacyPage } from "@/routes/privacy";

export const metadata: Metadata = {
  title: "Confidentialite",
  description: "Politique de confidentialite Immojudis.",
};

export default function Page() {
  return <PrivacyPage />;
}
