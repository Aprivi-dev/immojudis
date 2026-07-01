import type { Metadata } from "next";
import { LoginRouteClient } from "../_route-clients/LoginRouteClient";

export const metadata: Metadata = {
  title: "Connexion",
  description: "Connexion a votre compte Immojudis.",
};

export default function Page() {
  return <LoginRouteClient />;
}
