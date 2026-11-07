import { Badge } from "@/components/ui/primitives";
import type { PublicationRequestSummary } from "@/lib/publication-requests-client";

export function PublicationStatusPill({ status }: { status: PublicationRequestSummary["status"] }) {
  const [tone, label] =
    status === "approved"
      ? (["success", "Validée"] as const)
      : status === "rejected"
        ? (["danger", "Refusée"] as const)
        : (["warning", "En attente"] as const);
  return (
    <Badge tone={tone} className="shrink-0">
      {label}
    </Badge>
  );
}
