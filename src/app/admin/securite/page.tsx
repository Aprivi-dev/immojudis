import type { Metadata } from "next";
import { AdminSecurityPage } from "@/components/admin/AdminSecurityPage";

export const metadata: Metadata = {
  title: "Sécurité admin — Immojudis",
  description: "Double authentification du compte administrateur.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <AdminSecurityPage />;
}
