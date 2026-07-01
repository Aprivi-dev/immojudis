"use client";

import { Route } from "@/routes/sales.index";
import { LegacyRouteRenderer } from "./LegacyRouteRenderer";

export function SalesRouteClient() {
  return <LegacyRouteRenderer route={Route} />;
}
