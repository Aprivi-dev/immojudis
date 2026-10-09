import { useEffect, useRef, useState } from "react";
import CreditCard from "lucide-react/dist/esm/icons/credit-card.js";
import Settings from "lucide-react/dist/esm/icons/settings.js";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/hooks/use-auth";
import { Link, useNavigate } from "@/lib/router-compat";
import {
  fetchAccessPlan,
  fetchBillingOffer,
  openBillingPortal,
  startAnalyseCheckout,
} from "@/lib/client-billing";
import type { PlanCode } from "@/lib/plans";
import { LEGAL_DOCUMENTS, legalPublisherConfigurationStatus } from "@/lib/legal-documents";
import {
  ANALYSIS_RECURRING_LABEL,
  ANALYSIS_SUBSCRIPTION_ONLY_LABEL,
  ANALYSIS_TRIAL_LABEL,
  resolveAnalysisOfferLabel,
} from "@/lib/analysis-offer";
import { userMessage } from "@/lib/user-messages";

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
  const [hasStripeCustomer, setHasStripeCustomer] = useState(false);
  const [offerConfigured, setOfferConfigured] = useState(false);
  const [offerLabel, setOfferLabel] = useState(() => resolveAnalysisOfferLabel());
  const [trialAvailable, setTrialAvailable] = useState(true);
  const [busy, setBusy] = useState<"checkout" | "portal" | null>(null);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const checkoutTriggerRef = useRef<HTMLButtonElement>(null);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [immediatePerformanceAccepted, setImmediatePerformanceAccepted] = useState(false);
  const checkoutAvailable = legalPublisherConfigurationStatus().ready;

  useEffect(() => {
    let active = true;
    setPlan(null);
    setCurrentPeriodEnd(null);
    setHasStripeCustomer(false);

    fetchBillingOffer()
      .then((offer) => {
        if (active) {
          setOfferConfigured(offer.configured);
          setOfferLabel(offer.label);
          setTrialAvailable(offer.trialAvailable !== false);
        }
      })
      .catch(() => {
        if (active) setOfferConfigured(false);
      });

    if (user) {
      fetchAccessPlan()
        .then((response) => {
          if (active) {
            setPlan(response.plan.plan);
            setCurrentPeriodEnd(response.plan.currentPeriodEnd);
            setHasStripeCustomer(response.plan.billing?.hasStripeCustomer === true);
          }
        })
        .catch(() => {
          if (active) setPlan(null);
        });
    }

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

  async function openCheckoutReview() {
    if (loading || busy || !checkoutAvailable || !offerConfigured) return;
    if (!user) {
      await redirectToLogin();
      return;
    }

    setTermsAccepted(false);
    setImmediatePerformanceAccepted(false);
    setCheckoutOpen(true);
  }

  async function confirmCheckout() {
    if (
      !termsAccepted ||
      !immediatePerformanceAccepted ||
      busy ||
      !checkoutAvailable ||
      !offerConfigured
    )
      return;
    setBusy("checkout");
    try {
      const response = await startAnalyseCheckout({
        consent: {
          termsAccepted: true,
          termsVersion: LEGAL_DOCUMENTS.terms.version,
          privacyVersion: LEGAL_DOCUMENTS.privacy.version,
          paymentObligationAcknowledged: true,
          immediatePerformanceRequested: true,
          withdrawalInformationAcknowledged: true,
        },
      });
      window.location.assign(response.url);
    } catch (error) {
      toast.error(userMessage(error, "Paiement indisponible"));
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
      toast.error(userMessage(error, "Portail de paiement indisponible"));
      setBusy(null);
    }
  }

  const hasAnalysis = plan === "analyse";
  // A subscriber whose renewal failed has lost the plan but still needs the
  // portal to update the card: checkout would be refused for them.
  const managesBilling = hasAnalysis || hasStripeCustomer;
  const primaryLabel = managesBilling
    ? busy === "portal"
      ? "Ouverture..."
      : hasAnalysis
        ? "Gérer mon abonnement Analyse"
        : "Gérer mon abonnement"
    : !checkoutAvailable || !offerConfigured
      ? "Paiement temporairement indisponible"
      : busy === "checkout"
        ? "Redirection..."
        : trialAvailable
          ? "Démarrer l’essai Analyse"
          : "Souscrire à Analyse";
  const expiryLabel = formatAccessEnd(currentPeriodEnd);

  return (
    <>
      <div className={`flex flex-col gap-2 sm:flex-row ${className}`}>
        <button
          type="button"
          onClick={managesBilling ? openPortal : openCheckoutReview}
          ref={checkoutTriggerRef}
          disabled={
            loading ||
            Boolean(busy) ||
            (!managesBilling && (!checkoutAvailable || !offerConfigured))
          }
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
            {trialAvailable
              ? `${ANALYSIS_TRIAL_LABEL} · abonnement résiliable depuis le portail Stripe`
              : `${ANALYSIS_SUBSCRIPTION_ONLY_LABEL} · sans nouvel essai`}
          </span>
        )}
      </div>

      {!managesBilling && (!checkoutAvailable || !offerConfigured) ? (
        <p role="status" className="mt-3 text-sm leading-relaxed text-brand-navy/80">
          Les souscriptions sont temporairement indisponibles. Vous pouvez explorer gratuitement le
          catalogue.{" "}
          <Link to="/legal" className="underline">
            Voir les mentions légales
          </Link>
          .
        </p>
      ) : null}

      <Dialog open={checkoutOpen} onOpenChange={(open) => !busy && setCheckoutOpen(open)}>
        <DialogContent
          className="max-h-[92vh] overflow-y-auto sm:max-w-xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            checkoutTriggerRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Récapitulatif avant paiement</DialogTitle>
            <DialogDescription>
              Vérifiez l’offre et confirmez vos choix avant d’ouvrir le paiement sécurisé Stripe.
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-lg border border-border bg-muted/35 p-4 text-sm">
            <div className="flex items-center justify-between gap-4">
              <div>
                <strong className="text-foreground">Immojudis Analyse</strong>
                <p className="mt-1 text-xs text-muted-foreground">
                  {trialAvailable ? ANALYSIS_TRIAL_LABEL : "Abonnement immédiat, sans nouvel essai"}
                </p>
              </div>
              <strong className="text-lg text-foreground">{offerLabel}</strong>
            </div>
            <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
              {trialAvailable
                ? "Carte bancaire requise pendant l’essai. "
                : "Carte bancaire requise. "}
              {trialAvailable
                ? ANALYSIS_RECURRING_LABEL
                : "Abonnement récurrent résiliable depuis le portail Stripe"}
              . Le montant et la périodicité sont affichés par Stripe avant confirmation.
            </p>
          </div>

          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 text-sm leading-relaxed">
            <input
              type="checkbox"
              checked={termsAccepted}
              onChange={(event) => setTermsAccepted(event.target.checked)}
              className="mt-1 h-4 w-4"
            />
            <span>
              J’accepte les{" "}
              <Link
                to="/conditions-generales"
                target="_blank"
                className="font-semibold text-gold-text underline"
              >
                conditions générales
              </Link>{" "}
              (version {LEGAL_DOCUMENTS.terms.version}) et je reconnais que la commande m’oblige à{" "}
              {trialAvailable ? "démarrer l’essai, puis " : "souscrire à "}payer le tarif récurrent
              affiché par Stripe.
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 text-sm leading-relaxed">
            <input
              type="checkbox"
              checked={immediatePerformanceAccepted}
              onChange={(event) => setImmediatePerformanceAccepted(event.target.checked)}
              className="mt-1 h-4 w-4"
            />
            <span>
              Je demande l’exécution immédiate avant la fin du délai de rétractation et reconnais
              avoir reçu l’information sur mon droit de 14 jours et sur le montant proportionnel
              éventuellement dû pour le service déjà fourni. La{" "}
              <Link
                to="/privacy"
                target="_blank"
                className="font-semibold text-gold-text underline"
              >
                politique de confidentialité
              </Link>{" "}
              est accessible avant la commande.
            </span>
          </label>

          <DialogFooter>
            <button
              type="button"
              onClick={() => setCheckoutOpen(false)}
              disabled={Boolean(busy)}
              className="ij-login-button inline-flex items-center justify-center px-4 py-2 text-sm font-semibold disabled:opacity-60"
            >
              Annuler
            </button>
            <button
              type="button"
              onClick={confirmCheckout}
              disabled={
                !termsAccepted || !immediatePerformanceAccepted || Boolean(busy) || !offerConfigured
              }
              className="ij-signup-button inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50"
            >
              <CreditCard className="h-4 w-4" />
              {busy === "checkout" ? "Redirection…" : "Commander avec obligation de paiement"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
