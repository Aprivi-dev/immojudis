import CircleAlert from "lucide-react/dist/esm/icons/circle-alert.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import { saleVerificationLabel, saleVenueLabel, getSaleProcedure } from "@/lib/sale-procedure";
import type { AuctionSale } from "@/lib/types";

export function SaleProcedureBadge({ sale }: { sale: AuctionSale }) {
  const procedure = getSaleProcedure(sale);
  const verified = ["verified", "cross_checked"].includes(procedure.verificationStatus);

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] backdrop-blur ${
        verified
          ? "border-emerald-200 bg-emerald-50/95 text-emerald-900"
          : procedure.verificationStatus === "conflict"
            ? "border-red-200 bg-red-50/95 text-red-900"
            : "border-amber-200 bg-amber-50/95 text-amber-950"
      }`}
      title={`${saleVenueLabel(procedure.venueType)} · ${saleVerificationLabel(procedure.verificationStatus)}`}
    >
      {verified ? (
        <ShieldCheck className="h-3 w-3" aria-hidden />
      ) : (
        <CircleAlert className="h-3 w-3" aria-hidden />
      )}
      {saleVenueLabel(procedure.venueType)}
    </span>
  );
}
