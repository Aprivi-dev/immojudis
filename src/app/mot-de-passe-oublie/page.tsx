import type { Metadata } from "next";
import { PasswordRecovery } from "@/components/PasswordRecovery";

export const metadata: Metadata = {
  title: "Mot de passe oublié",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <PasswordRecovery />;
}
