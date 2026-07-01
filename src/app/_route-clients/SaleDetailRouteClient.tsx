"use client";

import { Route } from "@/routes/sales.$id";
import { LegacyRouteRenderer } from "./LegacyRouteRenderer";

export function SaleDetailRouteClient({ id, loaderData }: { id: string; loaderData?: unknown }) {
  return <LegacyRouteRenderer route={Route} params={{ id }} loaderData={loaderData} />;
}
