import type { Metadata } from "next";
import { LoginPage } from "@/routes/login";

export const metadata: Metadata = {
  title: "Connexion",
  description: "Connexion a votre compte Immojudis.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <LoginPage />;
}
