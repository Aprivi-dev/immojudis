import type { Metadata } from "next";
import { LegalPage } from "@/routes/legal";

export const metadata: Metadata = {
  alternates: { canonical: "/legal" },
  title: "Mentions légales",
  description: "Mentions légales Immojudis.",
};

export default function Page() {
  return <LegalPage />;
}
