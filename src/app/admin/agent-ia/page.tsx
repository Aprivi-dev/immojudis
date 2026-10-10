import type { Metadata } from "next";
import { AdminAgentPage } from "./admin-agent-page";

export const metadata: Metadata = {
  title: "Agent IA admin",
  description: "Configuration du template de prise de contact de l’agent IA Immojudis.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <AdminAgentPage />;
}
