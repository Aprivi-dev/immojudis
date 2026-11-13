import type { Metadata } from "next";
import { AdminSecurityPage } from "@/components/admin/AdminSecurityPage";

export const metadata: Metadata = {
  title: "Sécurité admin — Immojudis",
  description: "Double authentification du compte administrateur.",
};

export default function Page() {
  return <AdminSecurityPage />;
}
