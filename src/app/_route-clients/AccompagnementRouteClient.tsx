"use client";

import { Route } from "@/routes/accompagnement";
import { LegacyRouteRenderer } from "./LegacyRouteRenderer";

export function AccompagnementRouteClient() {
  return <LegacyRouteRenderer route={Route} />;
}
