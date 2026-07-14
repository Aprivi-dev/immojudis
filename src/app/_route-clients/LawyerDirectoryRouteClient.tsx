"use client";

import { Route } from "@/routes/avocats";
import { LegacyRouteRenderer } from "./LegacyRouteRenderer";

export function LawyerDirectoryRouteClient() {
  return <LegacyRouteRenderer route={Route} />;
}
