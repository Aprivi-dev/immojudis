import type { Metadata } from "next";
import { AuthGate } from "@/components/AuthGate";
import { PublishPage } from "@/routes/publish";

export const metadata: Metadata = {
  title: "Publier une vente",
  description:
    "Preparer une demande de publication de vente aux encheres immobiliere avec documents et validation admin.",
};

export default function Page() {
  return (
    <AuthGate>
      <PublishPage />
    </AuthGate>
  );
}
