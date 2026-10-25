import { useEffect, useRef, useState } from "react";
import CreditCard from "lucide-react/dist/esm/icons/credit-card.js";
import CircleX from "lucide-react/dist/esm/icons/circle-x.js";
import Settings from "lucide-react/dist/esm/icons/settings.js";
import { toast } from "@/lib/toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/hooks/use-auth";
import { useBillingOffer, type BillingOfferSource } from "@/hooks/use-billing-offer";
import { useLaunchOffer } from "@/hooks/use-launch-offer";
import { useCheckoutReturn } from "@/hooks/use-checkout-return";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { launchOfferText } from "@/lib/launch-offer";
import { loginPathWithRedirect } from "@/lib/navigation";
import {
  fetchAccessPlan,
  openBillingPortal,
  openSubscriptionCancellation,
  startAnalyseCheckout,
} from "@/lib/client-billing";
import {
  hasLiveStripeSubscription,
  pastDueGraceEnd,
  type PlanBilling,
  type PlanCode,
} from "@/lib/plans";
import { LEGAL_DOCUMENTS } from "@/lib/legal-documents";
import {
  ANALYSIS_RECURRING_LABEL,
  ANALYSIS_SUBSCRIPTION_ONLY_LABEL,
  ANALYSIS_TRIAL_LABEL,
  resolveAnalysisOfferLabel,
  STRIPE_CHECKOUT_TRIAL_OFFERED,
} from "@/lib/analysis-offer";
import { OfferOpeningRequest } from "@/components/OfferOpeningRequestLazy";
import { userMessage } from "@/lib/user-messages";
import { trackProductEvent } from "@/lib/product-events";

/** After a Stripe payment the webhook may take a moment: re-read the plan every 2 s, 30 s at most. */
const ACTIVATION_POLL_INTERVAL_MS = 2_000;
const ACTIVATION_POLL_WINDOW_MS = 30_000;

/** Statuses for which the cancellation flow of the Stripe portal can be opened. */
const CANCELLABLE_STATUSES: readonly string[] = ["trialing", "active", "past_due"];

type PlanReadState = "loading" | "ready" | "error";
type ActivationState = "idle" | "pending" | "active" | "timeout";

export function BillingActions({
  className = "",
  hideHelper = false,
  offerSource,
  handleCheckoutReturn = false,
}: {
  className?: string;
  hideHelper?: boolean;
  /** Offer already read by the page; without it this component reads the offer itself. */
  offerSource?: BillingOfferSource;
  /** Show the Stripe return message and wait for the plan to switch to Analyse. */
  handleCheckoutReturn?: boolean;
}) {
  const { user, loading } = useAuth();
  const userId = user?.id ?? null;
  const router = useRouter();
  const ownOffer = useBillingOffer(!offerSource);
  const { offer, reload: reloadOffer } = offerSource ?? ownOffer;
  const checkoutReturn = useCheckoutReturn(handleCheckoutReturn);
  const launch = useLaunchOffer();
  const [plan, setPlan] = useState<PlanCode | null>(null);
  // Plan Analyse pendant l'essai gratuit à l'inscription (pas d'abonnement) : aucun parcours de paiement.
  const [launchOfferPlan, setLaunchOfferPlan] = useState(false);
  const [planState, setPlanState] = useState<PlanReadState>("loading");
  const [currentPeriodEnd, setCurrentPeriodEnd] = useState<string | null>(null);
  const [billing, setBilling] = useState<PlanBilling | null>(null);
  const [activation, setActivation] = useState<ActivationState>("idle");
  const [busy, setBusy] = useState<"checkout" | "portal" | "cancel" | null>(null);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const checkoutTriggerRef = useRef<HTMLButtonElement>(null);
  const activationStartedAt = useRef<number | null>(null);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [immediatePerformanceAccepted, setImmediatePerformanceAccepted] = useState(false);

  const offerOpen = offer.status === "ready" && offer.open;
  const trialAvailable =
    offer.status === "ready" ? offer.trialAvailable : STRIPE_CHECKOUT_TRIAL_OFFERED;
  const offerLabel = (offer.status === "ready" ? offer.label : null) ?? resolveAnalysisOfferLabel();

  useEffect(() => {
    let active = true;
    setPlan(null);
    setLaunchOfferPlan(false);
    setCurrentPeriodEnd(null);
    setBilling(null);

    if (!userId) {
      setPlanState("ready");
      return;
    }
    setPlanState("loading");
    fetchAccessPlan()
      .then((response) => {
        if (!active) return;
        setPlan(response.plan.plan);
        setLaunchOfferPlan(response.plan.launchOffer === true);
        setCurrentPeriodEnd(response.plan.currentPeriodEnd);
        setBilling(response.plan.billing ?? null);
        setPlanState("ready");
      })
      .catch(() => {
        if (!active) return;
        setPlan(null);
        setPlanState("error");
      });

    return () => {
      active = false;
    };
  }, [userId]);

  // Back from a successful Stripe payment: the subscription is activated by a webhook,
  // so the plan may still read "Découverte" for a few seconds.
  useEffect(() => {
    if (checkoutReturn !== "success" || !userId || planState === "loading") return;
    if (plan === "analyse") {
      setActivation("active");
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    activationStartedAt.current ??= Date.now();
    setActivation("pending");

    const poll = async () => {
      try {
        const response = await fetchAccessPlan();
        if (!active) return;
        setCurrentPeriodEnd(response.plan.currentPeriodEnd);
        setBilling(response.plan.billing ?? null);
        setPlan(response.plan.plan);
        setLaunchOfferPlan(response.plan.launchOffer === true);
        if (response.plan.plan === "analyse") return;
      } catch {
        if (!active) return;
      }
      if (Date.now() - (activationStartedAt.current ?? Date.now()) >= ACTIVATION_POLL_WINDOW_MS) {
        setActivation("timeout");
        return;
      }
      timer = setTimeout(poll, ACTIVATION_POLL_INTERVAL_MS);
    };
    timer = setTimeout(poll, ACTIVATION_POLL_INTERVAL_MS);

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [checkoutReturn, userId, planState, plan]);

  // Abonné (ou premium, administrateur) : le portail de paiement s'applique. Le surclassement de
  // l'offre de lancement n'est pas un abonnement : il n'ouvre ni portail ni résiliation.
  const hasAnalysis = plan === "analyse" && !launchOfferPlan;
  // Only a real Stripe subscription sends to the portal.  A Stripe customer alone is not
  // enough: it exists as soon as the payment page opens, even if the visitor never paid.
  // A subscriber whose renewal failed has lost the plan but still needs the portal to
  // update the card: a new checkout would be refused for them.
  const managesBilling = hasAnalysis || hasLiveStripeSubscription(billing, currentPeriodEnd);
  // The cancellation flow needs a live Stripe subscription in a status Stripe can cancel.
  // The server checks this again against the user's own row and supplies the subscription id.
  const canCancel =
    managesBilling &&
    billing?.status != null &&
    CANCELLABLE_STATUSES.includes(billing.status) &&
    Boolean(currentPeriodEnd);
  const checkingAccount = loading || (Boolean(userId) && planState === "loading");

  function redirectToLogin() {
    const redirect =
      typeof window !== "undefined"
        ? `${window.location.pathname}${window.location.search}`
        : "/offres";
    router.push(loginPathWithRedirect(redirect, { reason: "offre" }));
  }

  async function openCheckoutReview() {
    if (loading || busy || !offerOpen) return;
    if (!user) {
      redirectToLogin();
      return;
    }

    setTermsAccepted(false);
    setImmediatePerformanceAccepted(false);
    setCheckoutOpen(true);
  }

  async function confirmCheckout() {
    if (!termsAccepted || !immediatePerformanceAccepted || busy || !offerOpen) return;
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
      trackProductEvent("checkout_started");
      window.location.assign(response.url);
    } catch (error) {
      toast.error(userMessage(error, "Paiement indisponible"));
      setBusy(null);
    }
  }

  async function openPortal() {
    if (loading || busy) return;
    if (!user) {
      redirectToLogin();
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

  async function openCancellation() {
    if (loading || busy) return;
    if (!user) {
      redirectToLogin();
      return;
    }

    setBusy("cancel");
    try {
      const response = await openSubscriptionCancellation();
      window.location.assign(response.url);
    } catch (error) {
      toast.error(userMessage(error, "Résiliation indisponible"));
      setBusy(null);
    }
  }

  const portalLabel =
    busy === "portal"
      ? "Ouverture..."
      : hasAnalysis
        ? "Gérer mon abonnement Analyse"
        : "Gérer mon abonnement";
  const purchaseLabel =
    busy === "checkout"
      ? "Redirection..."
      : trialAvailable
        ? "Démarrer l’essai Analyse"
        : "Souscrire à Analyse";
  const expiryLabel = formatAccessEnd(currentPeriodEnd, billing);
  const checkoutBanner = checkoutReturnBanner({
    checkoutReturn,
    signedIn: Boolean(userId),
    activation: hasAnalysis ? "active" : activation,
  });

  return (
    <>
      {checkoutBanner ? (
        <p
          role="status"
          className="mb-3 rounded-lg border border-border bg-muted/35 p-3 text-sm leading-relaxed text-brand-navy"
        >
          <strong>{checkoutBanner.title}</strong> {checkoutBanner.text}
        </p>
      ) : null}

      {managesBilling ? (
        <div className={`flex flex-col gap-2 sm:flex-row ${className}`}>
          <button
            type="button"
            onClick={openPortal}
            ref={checkoutTriggerRef}
            disabled={loading || Boolean(busy)}
            className="ij-signup-button inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60"
          >
            <CreditCard className="h-4 w-4" />
            {portalLabel}
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
          ) : null}
          {canCancel ? (
            <button
              type="button"
              onClick={openCancellation}
              disabled={loading || Boolean(busy)}
              className="ij-login-button inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60"
            >
              <CircleX className="h-4 w-4" aria-hidden />
              {busy === "cancel" ? "Ouverture..." : "Résilier mon abonnement"}
            </button>
          ) : null}
        </div>
      ) : launchOfferPlan ? (
        <LaunchOfferNotice audience="account" />
      ) : !userId && !loading && launch.active ? (
        <LaunchOfferNotice audience="visitor" />
      ) : checkingAccount || offer.status === "loading" || (!userId && launch.pending) ? (
        <div
          role="status"
          aria-busy="true"
          aria-label="Chargement de l’offre"
          className={`flex flex-col gap-2 sm:flex-row ${className}`}
        >
          <div aria-hidden className="h-11 w-full animate-pulse rounded-md bg-muted sm:w-64" />
        </div>
      ) : offer.status === "error" ? (
        <div role="alert" className="text-sm leading-relaxed text-brand-navy/80">
          <p>L’offre n’a pas pu être chargée. Ce n’est pas une fermeture des souscriptions.</p>
          <button
            type="button"
            onClick={reloadOffer}
            className="ij-login-button mt-2 inline-flex items-center justify-center px-4 py-2 text-sm font-semibold"
          >
            Réessayer
          </button>
        </div>
      ) : (
        <>
          {offerOpen ? (
            <div className={`flex flex-col gap-2 sm:flex-row ${className}`}>
              <button
                type="button"
                onClick={openCheckoutReview}
                ref={checkoutTriggerRef}
                disabled={loading || Boolean(busy)}
                className="ij-signup-button inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60"
              >
                <CreditCard className="h-4 w-4" />
                {purchaseLabel}
              </button>
              {!hideHelper ? (
                <span className="inline-flex items-center justify-center px-3 py-2 text-xs font-semibold text-muted-foreground">
                  {trialAvailable
                    ? `${ANALYSIS_TRIAL_LABEL} · abonnement résiliable depuis Mon compte`
                    : ANALYSIS_SUBSCRIPTION_ONLY_LABEL}
                </span>
              ) : null}
            </div>
          ) : (
            // Offre fermée : le bouton principal est la demande d'information, pas un achat.
            <div className={`text-sm leading-relaxed text-brand-navy/80 ${className}`}>
              <OfferOpeningRequest className="mt-0" primary />
              <p role="status" className="mt-3 font-medium">
                Tarif prévu : {offerLabel}. Pas encore souscriptible.
              </p>
              <p className="mt-1">
                Vous pouvez explorer gratuitement le catalogue.{" "}
                <Link href="/legal" className="underline">
                  Voir les mentions légales
                </Link>
                .
              </p>
            </div>
          )}
        </>
      )}

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
                  {trialAvailable ? ANALYSIS_TRIAL_LABEL : "Abonnement immédiat"}
                </p>
              </div>
              <strong className="text-lg text-foreground">{offerLabel}</strong>
            </div>
            <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
              {trialAvailable
                ? "Carte bancaire requise pendant l’essai. "
                : "Carte bancaire requise. "}
              {trialAvailable ? ANALYSIS_RECURRING_LABEL : ANALYSIS_SUBSCRIPTION_ONLY_LABEL}. Le
              montant et la périodicité sont affichés par Stripe avant confirmation.
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
                href="/conditions-generales"
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
                href="/privacy"
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
                !termsAccepted || !immediatePerformanceAccepted || Boolean(busy) || !offerOpen
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

/**
 * Essai gratuit à l'inscription : à la place du bouton d'achat, pour un compte en essai ou un
 * visiteur. Aucun paiement n'est proposé ; la mention donne les règles de l'essai (textes de
 * `src/lib/launch-offer.ts`). Après l'essai, le compte voit le parcours habituel (souscription, ou
 * « Me prévenir de l'ouverture » tant qu'elle est fermée).
 */
function LaunchOfferNotice({ audience }: { audience: "account" | "visitor" }) {
  return (
    <div
      role="status"
      data-testid="launch-offer-notice"
      className="rounded-lg border border-gold/30 bg-gold/10 p-3 text-sm leading-relaxed text-brand-navy"
    >
      <p>{launchOfferText(audience)}</p>
      {audience === "visitor" ? (
        <Link
          href={loginPathWithRedirect("/sales", { reason: "offre" })}
          className="mt-2 inline-flex min-h-11 items-center font-semibold text-gold-text underline underline-offset-4"
        >
          Créer mon compte gratuit
        </Link>
      ) : null}
    </div>
  );
}

function checkoutReturnBanner({
  checkoutReturn,
  signedIn,
  activation,
}: {
  checkoutReturn: "success" | "cancelled" | null;
  signedIn: boolean;
  activation: ActivationState;
}): { title: string; text: string } | null {
  if (checkoutReturn === "cancelled") {
    return {
      title: "Paiement annulé.",
      text: "Vous pouvez reprendre la souscription quand vous le souhaitez.",
    };
  }
  if (checkoutReturn !== "success" || !signedIn) return null;
  if (activation === "active") {
    return { title: "Paiement reçu.", text: "Votre accès Analyse est activé." };
  }
  if (activation === "timeout") {
    return {
      title: "Paiement reçu.",
      text: "L’activation prend plus de temps que prévu. Actualisez la page dans quelques minutes : votre accès apparaîtra dès qu’elle sera terminée.",
    };
  }
  return {
    title: "Paiement reçu, activation en cours.",
    text: "Votre accès Analyse sera disponible dans quelques secondes.",
  };
}

/**
 * End of access shown on the portal button.  For a renewal that failed (`past_due`),
 * `current_period_end` holds the start of the unpaid period (already past): access
 * actually ends with the grace period, computed as in `plans.ts`.
 */
function formatAccessEnd(
  currentPeriodEnd: string | null,
  billing: Pick<PlanBilling, "status" | "graceEndsAt"> | null = null,
): string | null {
  const value =
    billing?.status === "past_due"
      ? (billing.graceEndsAt ?? pastDueGraceEnd(currentPeriodEnd))
      : currentPeriodEnd;
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `Actif jusqu'au ${new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date)}`;
}
