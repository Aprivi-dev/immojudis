import CircleAlert from "lucide-react/dist/esm/icons/circle-alert.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import {
  getSaleProcedure,
  saleVenueLabel,
  saleVerificationExplanation,
} from "@/lib/sale-procedure";
import type { AuctionSale } from "@/lib/types";

export function SaleProcedureBadge({ sale }: { sale: AuctionSale }) {
  const procedure = getSaleProcedure(sale);
  const verified = ["verified", "cross_checked"].includes(procedure.verificationStatus);

  // Fondations (docs/design/fondations.md) : le type de vente est une information, en ton neutre ;
  // la couleur ne marque que ce qui demande l'attention (sources en conflit, vente non vérifiée).
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-caption font-medium backdrop-blur ${
        verified
          ? "border-line bg-white/95 text-brand-navy"
          : procedure.verificationStatus === "conflict"
            ? "border-danger/25 bg-danger-tint/95 text-danger"
            : "border-warning/25 bg-warning-tint/95 text-warning"
      }`}
      title={`${saleVenueLabel(procedure.venueType)} · ${saleVerificationExplanation(procedure.verificationStatus)}`}
    >
      {verified ? (
        <ShieldCheck className="h-3.5 w-3.5 text-success" aria-hidden />
      ) : (
        <CircleAlert className="h-3.5 w-3.5" aria-hidden />
      )}
      {saleVenueLabel(procedure.venueType)}
    </span>
  );
}
