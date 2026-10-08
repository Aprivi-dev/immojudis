import type { Metadata } from "next";
import { AboutPage } from "@/routes/a-propos";

export const metadata: Metadata = {
  alternates: { canonical: "/a-propos" },
  title: "À propos",
  description: "La mission Immojudis et l'approche produit.",
};

export default function Page() {
  return <AboutPage />;
}
