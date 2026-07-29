import type { Metadata } from "next";
import { ContactPage } from "@/routes/contact";

export const metadata: Metadata = {
  title: "Contact",
  description: "Contacter l'equipe Immojudis.",
};

export default function Page() {
  return <ContactPage />;
}
