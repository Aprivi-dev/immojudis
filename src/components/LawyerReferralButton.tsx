import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Handshake from "lucide-react/dist/esm/icons/handshake.js";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { useNavigate } from "@/lib/router-compat";
import {
  fetchFeatureEntitlements,
  fetchLawyerReferrals,
  requestLawyerReferral,
} from "@/lib/client-api";
import type { LawyerReferralSummary } from "@/lib/lawyer-referrals";

export function LawyerReferralButton({
  saleId,
  requestedLawyerId,
  label,
  className = "",
  onIntent,
}: {
  saleId: string;
  requestedLawyerId?: string;
  label?: string;
  className?: string;
  onIntent?: () => void;
}) {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const { data: entitlementsData, isLoading: entitlementsLoading } = useQuery({
    queryKey: ["feature-entitlements", user?.id ?? "anonymous"],
    queryFn: fetchFeatureEntitlements,
    enabled: Boolean(user) && !loading,
    staleTime: 5 * 60_000,
  });
  const { data: referralData, isLoading: referralsLoading } = useQuery({
    queryKey: ["lawyer-referrals", saleId],
    queryFn: () => fetchLawyerReferrals({ saleId, limit: 1 }),
    enabled: Boolean(user) && !loading,
    staleTime: 60_000,
  });

  const referralLocked = entitlementsData?.plan.features.lawyerReferrals === "locked";
  const latestRequest = referralData?.requests[0] ?? null;
  const hasOpenRequest =
    latestRequest?.status === "new" ||
    latestRequest?.status === "manual_review" ||
    latestRequest?.status === "sent_to_lawyer";

  async function requestReferral() {
    if (loading || busy || entitlementsLoading) return;
    onIntent?.();

    if (!user) {
      const redirect =
        typeof window !== "undefined"
          ? `${window.location.pathname}${window.location.search}#lawyer`
          : `/sales/${saleId}`;
      navigate({ to: "/login", search: { redirect } });
      return;
    }

    if (referralLocked) {
      toast.message("Mise en relation avocat réservée au plan Analyse.");
      navigate({ to: "/accompagnement" });
      return;
    }

    setBusy(true);
    try {
      const response = await requestLawyerReferral({
        data: { saleId, lawyerId: requestedLawyerId },
      });
      if (response.reusedExisting) {
        toast.message("Une demande de mise en relation existe déjà pour cette vente.");
      } else if (response.matchedLawyer) {
        toast.success(`Demande créée pour ${response.matchedLawyer.displayName}.`);
      } else {
        toast.success("Demande créée. ImmoJudis recherchera un avocat référencé sur cette zone.");
      }
      await queryClient.invalidateQueries({ queryKey: ["lawyer-referrals", saleId] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Demande impossible");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2">
      <button
        type="button"
        onClick={requestReferral}
        disabled={busy || loading || entitlementsLoading}
        className={`inline-flex items-center justify-center gap-2 rounded-md bg-gold-soft px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-gold disabled:opacity-50 ${className}`}
      >
        {referralLocked ? (
          <LockKeyhole className="h-3.5 w-3.5" />
        ) : (
          <Handshake className="h-3.5 w-3.5" />
        )}
        {busy
          ? "Demande en cours..."
          : entitlementsLoading || referralsLoading
            ? "Vérification..."
            : referralLocked
              ? "Débloquer la mise en relation"
              : hasOpenRequest
                ? "Demande avocat en cours"
                : (label ?? "Mise en relation ImmoJudis")}
      </button>
      {latestRequest ? <LawyerReferralStatus request={latestRequest} /> : null}
    </div>
  );
}

function LawyerReferralStatus({ request }: { request: LawyerReferralSummary }) {
  return (
    <div className="rounded-md border border-gold/20 bg-gold/5 p-3 text-left text-xs leading-relaxed text-muted-foreground">
      <div className="font-semibold text-foreground">{request.statusLabel}</div>
      <p className="mt-1">{request.nextStep}</p>
      {request.matchedLawyer ? (
        <p className="mt-2">
          Avocat référencé :{" "}
          <span className="font-medium text-foreground">
            {request.matchedLawyer.displayName}
            {request.matchedLawyer.firmName ? ` · ${request.matchedLawyer.firmName}` : ""}
          </span>
        </p>
      ) : (
        <p className="mt-2">Avocat référencé : attribution ImmoJudis en cours.</p>
      )}
      <p className="mt-2 text-[11px] uppercase tracking-[0.08em]">
        Créée le {formatShortDate(request.createdAt)}
      </p>
    </div>
  );
}

function formatShortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "date à confirmer";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}
