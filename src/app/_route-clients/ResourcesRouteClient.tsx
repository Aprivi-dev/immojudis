"use client";

import { Route } from "@/routes/ventes-immobilieres-judiciaires";
import { LegacyRouteRenderer } from "./LegacyRouteRenderer";

export function ResourcesRouteClient() {
  return <LegacyRouteRenderer route={Route} />;
}
