"use client";

import { Route } from "@/routes/privacy";
import { LegacyRouteRenderer } from "./LegacyRouteRenderer";

export function PrivacyRouteClient() {
  return <LegacyRouteRenderer route={Route} />;
}
