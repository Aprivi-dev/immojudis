import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DEFAULT_PROPERTY } from "@/lib/mock-property";

const PROPERTY_DEMO_ENABLED = process.env.ENABLE_PROPERTY_DEMO === "true";

export const metadata: Metadata = {
  title: "Fiche demo immobiliere",
  robots: {
    index: false,
    follow: false,
  },
};

export default function Page() {
  if (!PROPERTY_DEMO_ENABLED) redirect("/annonce-exemple");
  redirect(`/properties/${DEFAULT_PROPERTY.slug}`);
}
