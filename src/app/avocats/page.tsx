import type { Metadata } from "next";
import { LawyerDirectoryPage } from "@/routes/avocats";

export const metadata: Metadata = {
  alternates: { canonical: "/avocats" },
  title: "Annuaire des avocats en droit immobilier",
  description:
    "Trouvez un avocat en droit immobilier par barreau et identifiez clairement les profils partenaires sponsorisés.",
};

export default function Page() {
  return <LawyerDirectoryPage />;
}
