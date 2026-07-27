import type { Metadata } from "next";
import { LoginRouteClient } from "../_route-clients/LoginRouteClient";

export const metadata: Metadata = {
  title: "Connexion",
  description: "Connexion a votre compte Immojudis.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <LoginRouteClient />;
}
