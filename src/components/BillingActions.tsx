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
  hideHelper = false,
}: {
  className?: string;
  hideHelper?: boolean;
}) {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [plan, setPlan] = useState<PlanCode | null>(null);
  const [currentPeriodEnd, setCurrentPeriodEnd] = useState<string | null>(null);
  const [busy, setBusy] = useState<"checkout" | "portal" | null>(null);

  useEffect(() => {
    let active = true;
    if (!user) {
      setPlan(null);
      setCurrentPeriodEnd(null);
      return;
    }

    setPlan(null);
    setCurrentPeriodEnd(null);

    fetchFeatureEntitlements()
      .then((response) => {
        if (active) {
          setPlan(response.plan.plan);
          setCurrentPeriodEnd(response.plan.currentPeriodEnd);
        }
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
      const response = await startAnalyseCheckout();
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
      toast.error(error instanceof Error ? error.message : "Portail de paiement indisponible");
      setBusy(null);
    }
  }

  const hasAnalysis = plan === "analyse";
  const primaryLabel =
    busy === "checkout"
      ? "Redirection..."
      : hasAnalysis
        ? "Prolonger de 30 jours — 29 €"
        : "Débloquer Analyse — 29 € / 30 jours";
  const expiryLabel = formatAccessEnd(currentPeriodEnd);

  return (
    <div className={`flex flex-col gap-2 sm:flex-row ${className}`}>
      <button
        type="button"
        onClick={startCheckout}
        disabled={loading || Boolean(busy)}
        className="ij-signup-button inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60"
      >
        <CreditCard className="h-4 w-4" />
        {primaryLabel}
      </button>
      {hasAnalysis ? (
        <button
          type="button"
          onClick={openPortal}
          disabled={loading || Boolean(busy)}
          className="ij-login-button inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Settings className="h-4 w-4" />
          {busy === "portal" ? "Ouverture..." : (expiryLabel ?? "Voir mes paiements")}
        </button>
      ) : hideHelper ? null : (
        <span className="inline-flex items-center justify-center px-3 py-2 text-xs font-semibold text-muted-foreground">
          Paiement unique · aucun renouvellement automatique
        </span>
      )}
    </div>
  );
}

function formatAccessEnd(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `Actif jusqu'au ${new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date)}`;
}
