import { useEffect, useRef, useState } from "react";
import Bell from "lucide-react/dist/esm/icons/bell.js";
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
import { useBillingOffer, type BillingOfferSource } from "@/hooks/use-billing-offer";
import { useCheckoutReturn } from "@/hooks/use-checkout-return";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { pathWithSearch } from "@/lib/navigation";
import {
  fetchAccessPlan,
  fetchOfferOpeningNotification,
  openBillingPortal,
  startAnalyseCheckout,
  updateOfferOpeningNotification,
} from "@/lib/client-billing";
import { hasLiveStripeSubscription, type PlanBilling, type PlanCode } from "@/lib/plans";
import { LEGAL_DOCUMENTS } from "@/lib/legal-documents";
import {
  ANALYSIS_RECURRING_LABEL,
  ANALYSIS_SUBSCRIPTION_ONLY_LABEL,
  ANALYSIS_TRIAL_LABEL,
  resolveAnalysisOfferLabel,
} from "@/lib/analysis-offer";
import { OFFER_OPENING_CONSENT_TEXT } from "@/lib/offer-opening-notification";
import { userMessage } from "@/lib/user-messages";

/** After a Stripe payment the webhook may take a moment: re-read the plan every 2 s, 30 s at most. */
const ACTIVATION_POLL_INTERVAL_MS = 2_000;
const ACTIVATION_POLL_WINDOW_MS = 30_000;

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
  const [plan, setPlan] = useState<PlanCode | null>(null);
  const [planState, setPlanState] = useState<PlanReadState>("loading");
  const [currentPeriodEnd, setCurrentPeriodEnd] = useState<string | null>(null);
  const [billing, setBilling] = useState<PlanBilling | null>(null);
  const [activation, setActivation] = useState<ActivationState>("idle");
  const [busy, setBusy] = useState<"checkout" | "portal" | null>(null);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const checkoutTriggerRef = useRef<HTMLButtonElement>(null);
  const activationStartedAt = useRef<number | null>(null);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [immediatePerformanceAccepted, setImmediatePerformanceAccepted] = useState(false);
  const [openingRequested, setOpeningRequested] = useState<boolean | null>(null);
  const [openingBusy, setOpeningBusy] = useState(false);

  const offerReady = offer.status === "ready";
  const offerOpen = offer.status === "ready" && offer.open;
  const trialAvailable = offer.status === "ready" ? offer.trialAvailable : true;
  const offerLabel = (offer.status === "ready" ? offer.label : null) ?? resolveAnalysisOfferLabel();

  useEffect(() => {
    let active = true;
    setPlan(null);
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

  const hasAnalysis = plan === "analyse";
  // Only a real Stripe subscription sends to the portal.  A Stripe customer alone is not
  // enough: it exists as soon as the payment page opens, even if the visitor never paid.
  // A subscriber whose renewal failed has lost the plan but still needs the portal to
  // update the card: a new checkout would be refused for them.
  const managesBilling = hasAnalysis || hasLiveStripeSubscription(billing, currentPeriodEnd);
  const checkingAccount = loading || (Boolean(userId) && planState === "loading");
  const showOpeningRequest = !managesBilling && !checkingAccount && offerReady && !offerOpen;

  useEffect(() => {
    if (!userId || !showOpeningRequest) return;
    let active = true;
    fetchOfferOpeningNotification()
      .then((response) => {
        if (active) setOpeningRequested(response.notification.requested);
      })
      .catch(() => {
        if (active) setOpeningRequested(null);
      });
    return () => {
      active = false;
    };
  }, [userId, showOpeningRequest]);

  function redirectToLogin() {
    const redirect =
      typeof window !== "undefined"
        ? `${window.location.pathname}${window.location.search}`
        : "/offres";
    router.push(pathWithSearch("/login", { redirect }));
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

  async function changeOpeningRequest(enabled: boolean) {
    if (openingBusy) return;
    if (!user) {
      router.push(pathWithSearch("/login", { mode: "investor", redirect: "/offres" }));
      return;
    }
    setOpeningBusy(true);
    try {
      const response = await updateOfferOpeningNotification(enabled);
      setOpeningRequested(response.notification.requested);
    } catch (error) {
      toast.error(userMessage(error, "Demande impossible"));
    } finally {
      setOpeningBusy(false);
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
  const expiryLabel = formatAccessEnd(currentPeriodEnd);
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
        </div>
      ) : checkingAccount || offer.status === "loading" ? (
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
          <div className={`flex flex-col gap-2 sm:flex-row ${className}`}>
            <button
              type="button"
              onClick={openCheckoutReview}
              ref={checkoutTriggerRef}
              disabled={loading || Boolean(busy) || !offerOpen}
              className="ij-signup-button inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60"
            >
              <CreditCard className="h-4 w-4" />
              {offerOpen ? purchaseLabel : "Ouverture prochaine"}
            </button>
            {offerOpen && !hideHelper ? (
              <span className="inline-flex items-center justify-center px-3 py-2 text-xs font-semibold text-muted-foreground">
                {trialAvailable
                  ? `${ANALYSIS_TRIAL_LABEL} · abonnement résiliable depuis le portail Stripe`
                  : `${ANALYSIS_SUBSCRIPTION_ONLY_LABEL} · sans nouvel essai`}
              </span>
            ) : null}
          </div>

          {!offerOpen ? (
            <div className="mt-3 text-sm leading-relaxed text-brand-navy/80">
              <p role="status">
                Les souscriptions ouvriront prochainement. Vous pouvez explorer gratuitement le
                catalogue.{" "}
                <Link href="/legal" className="underline">
                  Voir les mentions légales
                </Link>
                .
              </p>
              {openingRequested ? (
                <p role="status" className="mt-3 font-medium">
                  Votre demande est enregistrée : un email vous préviendra à l’ouverture.{" "}
                  <button
                    type="button"
                    onClick={() => changeOpeningRequest(false)}
                    disabled={openingBusy}
                    className="font-semibold underline disabled:opacity-60"
                  >
                    Retirer ma demande
                  </button>
                </p>
              ) : (
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => changeOpeningRequest(true)}
                    disabled={openingBusy || loading}
                    className="ij-login-button inline-flex w-full items-center justify-center gap-2 px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Bell className="h-4 w-4" aria-hidden />
                    Me prévenir de l’ouverture
                  </button>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {user
                      ? OFFER_OPENING_CONSENT_TEXT
                      : "Un compte gratuit est nécessaire pour être prévenu : vous serez invité à le créer."}
                  </p>
                </div>
              )}
            </div>
          ) : null}
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
