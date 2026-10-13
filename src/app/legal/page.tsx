import type { Metadata } from "next";
import { LegalPage } from "@/routes/legal";

export const metadata: Metadata = {
  alternates: { canonical: "/legal" },
  title: "Mentions légales",
  description:
    "Mentions légales d’Immojudis : éditeur et responsable de publication, hébergement, objet du service et propriété intellectuelle.",
};

export default function Page() {
  return <LegalPage />;
}
