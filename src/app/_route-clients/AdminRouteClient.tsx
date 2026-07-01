"use client";

import { Route } from "@/routes/admin";
import { LegacyRouteRenderer } from "./LegacyRouteRenderer";

export function AdminRouteClient() {
  return <LegacyRouteRenderer route={Route} />;
}
