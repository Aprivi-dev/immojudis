import type { Metadata } from "next";
import { ProfessionalWorkspacePage } from "./professional-workspace-page";

export const metadata: Metadata = {
  title: "Espace pro",
  description: "Suivre les demandes de publication déposées et les ventes publiées.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <ProfessionalWorkspacePage />;
}
