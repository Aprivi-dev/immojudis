"use client";

import { Route } from "@/routes/login";
import { LegacyRouteRenderer } from "./LegacyRouteRenderer";

export function LoginRouteClient() {
  return <LegacyRouteRenderer route={Route} />;
}
