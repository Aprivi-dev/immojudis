import type { Metadata } from "next";
import { LegalPage } from "@/routes/legal";

export const metadata: Metadata = {
  title: "Mentions legales",
  description: "Mentions legales Immojudis.",
};

export default function Page() {
  return <LegalPage />;
}
