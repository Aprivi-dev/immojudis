import type { Metadata } from "next";
import { PasswordRecovery } from "@/components/PasswordRecovery";

export const metadata: Metadata = {
  title: "Nouveau mot de passe",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <PasswordRecovery reset />;
}
