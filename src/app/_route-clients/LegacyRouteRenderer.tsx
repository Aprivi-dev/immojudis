"use client";

import type * as React from "react";
import { RouteCompatProvider } from "@/lib/router-compat";

type LegacyRoute = {
  options?: {
    component?: React.ComponentType;
  };
  component?: React.ComponentType;
};

export function LegacyRouteRenderer({
  route,
  loaderData,
  params,
}: {
  route: LegacyRoute;
  loaderData?: unknown;
  params?: Record<string, string | string[] | undefined>;
}) {
  const Component = route.options?.component ?? route.component;
  if (!Component) return null;

  return (
    <RouteCompatProvider loaderData={loaderData} params={params}>
      <Component />
    </RouteCompatProvider>
  );
}
