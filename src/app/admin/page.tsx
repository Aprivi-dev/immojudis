import type { Metadata } from "next";
import { AdminHomePage } from "./admin-home-page";

export const metadata: Metadata = {
  title: "Admin",
  description: "Dashboard administrateur Immojudis.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <AdminHomePage />;
}
