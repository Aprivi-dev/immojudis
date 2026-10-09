"use client";

import { createFileRoute } from "@/lib/router-compat";
import { CinematicHero } from "@/components/CinematicHome";
import { HomeDiscovery } from "@/components/HomeDiscovery";

export const Route = createFileRoute("/")({
  component: HomePage,
});

export function HomePage() {
  return (
    <main className="ij-page ij-cinematic-page">
      <CinematicHero />
      <HomeDiscovery />
    </main>
  );
}
