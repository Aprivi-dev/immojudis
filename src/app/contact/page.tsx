import type { Metadata } from "next";
import { ContactPage } from "@/routes/contact";

export const metadata: Metadata = {
  alternates: { canonical: "/contact" },
  title: "Contact",
  description: "Contacter l’équipe Immojudis.",
};

export default function Page() {
  return <ContactPage />;
}
