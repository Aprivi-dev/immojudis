import type { Metadata } from "next";
import { AdminAgentPage } from "@/routes/admin.agent-ia";

export const metadata: Metadata = {
  title: "Agent IA admin",
  description: "Configuration du template de prise de contact de l’agent IA Immojudis.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <AdminAgentPage />;
}
