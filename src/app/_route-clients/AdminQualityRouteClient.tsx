"use client";

import { Route } from "@/routes/admin.quality";
import { LegacyRouteRenderer } from "./LegacyRouteRenderer";

export function AdminQualityRouteClient() {
  return <LegacyRouteRenderer route={Route} />;
}
