import type { Metadata } from "next";
import { AdminPublicationsPage } from "./admin-publications-page";

export const metadata: Metadata = {
  title: "Publications admin",
  description: "Validation des demandes de publication Immojudis.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <AdminPublicationsPage />;
}
