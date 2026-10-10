import type { Metadata } from "next";
import { LoginPage } from "./login-page";

export const metadata: Metadata = {
  title: "Connexion",
  description: "Connexion à votre compte Immojudis.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <LoginPage />;
}
