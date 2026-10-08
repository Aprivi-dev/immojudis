import type { Metadata } from "next";
import { TermsPage } from "@/routes/conditions-generales";

export const metadata: Metadata = {
  alternates: { canonical: "/conditions-generales" },
  title: "Conditions générales",
  description: "Conditions générales d’utilisation et de vente Immojudis.",
};

export default function Page() {
  return <TermsPage />;
}
