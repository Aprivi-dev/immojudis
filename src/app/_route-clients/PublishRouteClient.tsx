"use client";

import { Route } from "@/routes/publish";
import { LegacyRouteRenderer } from "./LegacyRouteRenderer";

export function PublishRouteClient() {
  return <LegacyRouteRenderer route={Route} />;
}
