import type { Metadata } from "next";
import { AdminRouteClient } from "../_route-clients/AdminRouteClient";

export const metadata: Metadata = {
  title: "Admin",
  description: "Dashboard administrateur Immojudis.",
};

export default function Page() {
  return <AdminRouteClient />;
}
