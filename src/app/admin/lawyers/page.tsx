import type { Metadata } from "next";
import { AdminLawyersPage } from "./admin-lawyers-page";

export const metadata: Metadata = {
  title: "Avocats admin",
  description: "Gestion du réseau d’avocats et des mises en relation Immojudis.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <AdminLawyersPage />;
}
