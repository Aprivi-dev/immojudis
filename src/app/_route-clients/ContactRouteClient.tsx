"use client";

import { Route } from "@/routes/contact";
import { LegacyRouteRenderer } from "./LegacyRouteRenderer";

export function ContactRouteClient() {
  return <LegacyRouteRenderer route={Route} />;
}
