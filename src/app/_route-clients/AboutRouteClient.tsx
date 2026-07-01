"use client";

import { Route } from "@/routes/a-propos";
import { LegacyRouteRenderer } from "./LegacyRouteRenderer";

export function AboutRouteClient() {
  return <LegacyRouteRenderer route={Route} />;
}
