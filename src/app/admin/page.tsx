import type { Metadata } from "next";
import { AdminHomePage } from "@/routes/admin";

export const metadata: Metadata = {
  title: "Admin",
  description: "Dashboard administrateur Immojudis.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <AdminHomePage />;
}
