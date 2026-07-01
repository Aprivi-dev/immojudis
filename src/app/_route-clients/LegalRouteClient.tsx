"use client";

import { Route } from "@/routes/legal";
import { LegacyRouteRenderer } from "./LegacyRouteRenderer";

export function LegalRouteClient() {
  return <LegacyRouteRenderer route={Route} />;
}
