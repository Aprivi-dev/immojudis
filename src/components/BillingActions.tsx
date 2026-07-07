import { useEffect, useState } from "react";
import CreditCard from "lucide-react/dist/esm/icons/credit-card.js";
import Settings from "lucide-react/dist/esm/icons/settings.js";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { useNavigate } from "@/lib/router-compat";
import {
  fetchFeatureEntitlements,
  openBillingPortal,
  startAnalyseCheckout,
} from "@/lib/client-api";
import type { PlanCode } from "@/lib/plans";

export function BillingActions({
  className = "",
  targetPlan = "analyse",
}: {
  className?: string;
  targetPlan?: Exclude<PlanCode, "decouverte">;
}) {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [plan, setPlan] = useState<PlanCode | null>(null);
  const [busy, setBusy] = useState<"checkout" | "portal" | null>(null);

  useEffect(() => {
    let active = true;
    if (!user) {
      setPlan(null);
      return;
    }

    fetchFeatureEntitlements()
      .then((response) => {
        if (active) setPlan(response.plan.plan);
      })
      .catch(() => {
        if (active) setPlan(null);
      });

    return () => {
      active = false;
    };
  }, [user]);

  async function redirectToLogin() {
    const redirect =
      typeof window !== "undefined"
        ? `${window.location.pathname}${window.location.search}`
        : "/accompagnement";
    await navigate({ to: "/login", search: { redirect } });
  }

  async function startCheckout() {
    if (loading || busy) return;
    if (!user) {
      await redirectToLogin();
      return;
    }

    setBusy("checkout");
    try {
      const response = await startAnalyseCheckout(targetPlan);
      window.location.assign(response.url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Paiement indisponible");
      setBusy(null);
    }
  }

  async function openPortal() {
    if (loading || busy) return;
    if (!user) {
      await redirectToLogin();
      return;
    }

    setBusy("portal");
    try {
      const response = await openBillingPortal();
      window.location.assign(response.url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Portail d'abonnement indisponible");
      setBusy(null);
    }
  }

  const hasTargetPlan = planRank(plan) >= planRank(targetPlan);
  const targetLabel = targetPlan === "investisseur" ? "Investisseur" : "Analyse";
  const primaryLabel = hasTargetPlan
    ? busy === "portal"
      ? "Ouverture..."
      : "Gérer l'abonnement"
    : busy === "checkout"
      ? "Redirection..."
      : `Activer ${targetLabel}`;

  return (
    <div className={`flex flex-col gap-2 sm:flex-row ${className}`}>
      <button
        type="button"
        onClick={hasTargetPlan ? openPortal : startCheckout}
        disabled={loading || Boolean(busy)}
        className="ij-signup-button inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60"
      >
        {hasTargetPlan ? <Settings className="h-4 w-4" /> : <CreditCard className="h-4 w-4" />}
        {primaryLabel}
      </button>
      {!hasTargetPlan ? (
        <button
          type="button"
          onClick={openPortal}
          disabled={loading || Boolean(busy)}
          className="ij-login-button inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Settings className="h-4 w-4" />
          Déjà abonné
        </button>
      ) : null}
    </div>
  );
}

function planRank(plan: PlanCode | null): number {
  if (plan === "investisseur") return 2;
  if (plan === "analyse") return 1;
  return 0;
}
