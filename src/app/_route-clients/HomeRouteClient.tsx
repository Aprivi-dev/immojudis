"use client";

import { Route } from "@/routes/index";
import { LegacyRouteRenderer } from "./LegacyRouteRenderer";

export function HomeRouteClient() {
  return <LegacyRouteRenderer route={Route} />;
}
