import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Handshake from "lucide-react/dist/esm/icons/handshake.js";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { useRouter } from "next/navigation";
import { pathWithSearch } from "@/lib/navigation";
import { fetchAccessPlan, fetchLawyerReferrals, requestLawyerReferral } from "@/lib/client-api";
import type { LawyerReferralSummary } from "@/lib/lawyer-referrals";
import { userMessage } from "@/lib/user-messages";
import { queryKeys } from "@/lib/query-keys";

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
  const router = useRouter();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  // P4-13: the user sees what is shared with the lawyer and confirms before anything is sent.
  const [confirming, setConfirming] = useState(false);
  const [consent, setConsent] = useState(false);
  const { data: entitlementsData, isLoading: entitlementsLoading } = useQuery({
    queryKey: queryKeys.featureEntitlementsPlan(user?.id ?? "anonymous"),
    queryFn: fetchAccessPlan,
    enabled: Boolean(user) && !loading,
    staleTime: 5 * 60_000,
  });
  const { data: referralData, isLoading: referralsLoading } = useQuery({
    queryKey: queryKeys.lawyerReferrals(user?.id ?? "anonymous", saleId),
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

  function openRecap() {
    if (loading || busy || entitlementsLoading) return;
    onIntent?.();

    if (!user) {
      const redirect =
        typeof window !== "undefined"
          ? `${window.location.pathname}${window.location.search}#lawyer`
          : `/sales/${saleId}`;
      router.push(pathWithSearch("/login", { redirect }));
      return;
    }

    if (referralLocked) {
      toast.message("Mise en relation avocat réservée à l’offre Analyse.");
      router.push("/offres");
      return;
    }

    setConsent(false);
    setConfirming(true);
  }

  async function sendReferral() {
    if (loading || busy || !user || !consent) return;

    setBusy(true);
    try {
      const response = await requestLawyerReferral({
        data: { saleId, lawyerId: requestedLawyerId, dataSharingConfirmed: true },
      });
      setConfirming(false);
      setConsent(false);
      if (response.reusedExisting) {
        toast.message("Une demande de mise en relation existe déjà pour cette vente.");
      } else if (response.matchedLawyer) {
        toast.success(`Demande créée pour ${response.matchedLawyer.displayName}.`);
      } else {
        toast.success(
          "Demande créée. Immojudis recherchera un avocat référencé du barreau du tribunal.",
        );
      }
      await queryClient.invalidateQueries({
        queryKey: queryKeys.lawyerReferrals(user.id, saleId),
      });
    } catch (error) {
      toast.error(userMessage(error, "Demande impossible"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2">
      <button
        type="button"
        onClick={openRecap}
        disabled={busy || loading || entitlementsLoading || confirming}
        className={`inline-flex items-center justify-center gap-2 rounded-md bg-gold-soft px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-gold-text disabled:opacity-50 ${className}`}
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
                : (label ?? "Mise en relation Immojudis")}
      </button>
      {confirming ? (
        <LawyerReferralRecap
          consent={consent}
          busy={busy}
          onConsentChange={setConsent}
          onConfirm={sendReferral}
          onCancel={() => {
            setConfirming(false);
            setConsent(false);
          }}
        />
      ) : null}
      {latestRequest ? <LawyerReferralStatus request={latestRequest} /> : null}
    </div>
  );
}

function LawyerReferralRecap({
  consent,
  busy,
  onConsentChange,
  onConfirm,
  onCancel,
}: {
  consent: boolean;
  busy: boolean;
  onConsentChange: (value: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="group"
      aria-label="Récapitulatif avant mise en relation"
      className="rounded-md border border-gold/30 bg-gold/5 p-3 text-left text-xs leading-relaxed text-muted-foreground"
    >
      <div className="font-semibold text-foreground">
        Avant l'envoi, vérifiez ce qui est transmis
      </div>
      <ul className="mt-2 list-disc space-y-1 pl-4">
        <li>L'adresse email de votre compte, pour que l'avocat puisse vous répondre.</li>
        <li>La référence de cette vente.</li>
        <li>Votre mode de contact préféré (email par défaut).</li>
      </ul>
      <p className="mt-2">
        L'avocat proposé est inscrit au barreau du tribunal qui juge cette vente. L'avocat qui
        poursuit la vente n'est jamais proposé. Aucune autre donnée de votre compte n'est transmise.
      </p>
      <label className="mt-3 flex items-start gap-2 text-foreground">
        <input
          type="checkbox"
          checked={consent}
          onChange={(event) => onConsentChange(event.target.checked)}
          className="mt-0.5 h-3.5 w-3.5"
        />
        <span>J'accepte que ces informations soient transmises à l'avocat référencé.</span>
      </label>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={!consent || busy}
          className="inline-flex items-center justify-center rounded-md bg-gold-soft px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-gold disabled:opacity-50"
        >
          {busy ? "Demande en cours..." : "Envoyer la demande"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="inline-flex items-center justify-center rounded-md border border-border px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-50"
        >
          Annuler
        </button>
      </div>
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
        <p className="mt-2">Avocat référencé : attribution Immojudis en cours.</p>
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
