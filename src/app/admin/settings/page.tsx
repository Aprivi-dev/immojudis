import type { Metadata } from "next";
import { AdminSettingsPage } from "@/components/admin/AdminSettingsPage";

export const metadata: Metadata = {
  title: "Configuration admin",
  description: "Réglages de collecte, limites IA et configuration des services.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <AdminSettingsPage />;
}
