"use client";

import { TribunalJudicialActivityExplorer } from "@/components/TribunalJudicialActivityExplorer";
import { createFileRoute } from "@/lib/router-compat";

export const Route = createFileRoute("/tribunaux")({
  component: TribunalsPage,
});

export function TribunalsPage() {
  return <TribunalJudicialActivityExplorer />;
}
