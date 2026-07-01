"use client";

import { Route } from "@/routes/annonce-exemple";
import { LegacyRouteRenderer } from "./LegacyRouteRenderer";

export function ExampleSaleRouteClient() {
  return <LegacyRouteRenderer route={Route} />;
}
