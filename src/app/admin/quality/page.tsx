import type { Metadata } from "next";
import { AdminQualityPage } from "./admin-quality-page";

export const metadata: Metadata = {
  title: "Qualité des données",
  description: "Suivi de la qualité des données Immojudis.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <AdminQualityPage />;
}
