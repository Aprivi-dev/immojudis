"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { AccountLaunchOfferEnd } from "@/components/AccountLaunchOfferEnd";
import { AlertEmailRecapToggle } from "@/components/AlertEmailRecapToggle";
import { BillingActions } from "@/components/BillingActions";
import { InvestorProfileForm } from "@/components/InvestorProfileForm";
import { SaleRemindersToggle } from "@/components/SaleRemindersToggle";
import { SaleResultsToggle } from "@/components/SaleResultsToggle";
import { WeeklyDigestToggle } from "@/components/WeeklyDigestToggle";
import { Card, Notice, PageShell, buttonClasses } from "@/components/ui/primitives";
import { useAccessPlanQuery } from "@/hooks/use-access-plan";
import { useAuth } from "@/hooks/use-auth";
import { fetchSaleUnlocksOverview } from "@/lib/client-api";
import { accountLinksFor } from "@/lib/navigation";
import { LAUNCH_OFFER_ACCOUNT_TEXT, signupTrialStatusText } from "@/lib/launch-offer";
import { hasLiveStripeSubscription } from "@/lib/plans";
import * as queryKeys from "@/lib/query-keys";
import { unlockUsageLine } from "@/lib/sale-unlocks";

const dateFormat = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

const TOGGLE_CLASS =
  "mt-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-4 py-3 text-sm";

/** Ce que l'on retrouve derrière chaque entrée de « Mon espace ». */
const SPACE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "/favoris": "Les ventes que vous suivez, sur tous vos appareils.",
  "/alertes": "Vos recherches enregistrées et les nouvelles ventes qui y correspondent.",
  "/compte/ventes-debloquees": "Les ventes que vous avez ouvertes en détail.",
  "/comparaisons": "Vos ventes mises côte à côte.",
};

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : dateFormat.format(date);
}

export function AccountPage() {
  const { user } = useAuth();
  const planQuery = useAccessPlanQuery(user?.id);
  const plan = planQuery.data?.plan;
  // « 3 déblocages par mois » : seul un compte qui n'a pas déjà toutes les ventes les consomme.
  const unlocksQuery = useQuery({
    queryKey: queryKeys.saleUnlocksOverview(user?.id ?? null),
    queryFn: fetchSaleUnlocksOverview,
    enabled: Boolean(user) && plan != null && !plan.hasAnalysisAccess,
    staleTime: 60_000,
    retry: false,
  });
  const unlockStatus = unlocksQuery.data?.status;
  // « Mon espace » : les mêmes entrées que le menu « Mon compte », sans cette page elle-même.
  const spaceLinks = accountLinksFor(plan?.hasAnalysisAccess).filter(
    (link) => link.href in SPACE_DESCRIPTIONS,
  );
  const pastDue = plan?.billing?.status === "past_due";
  const graceEnd = formatDate(plan?.billing?.graceEndsAt);
  const periodEnd = formatDate(plan?.currentPeriodEnd);
  // Plan Analyse grâce à l'essai à l'inscription : pas d'abonnement, donc ni portail ni période payée.
  const launchOffer = plan?.launchOffer === true;
  const trialStatus = plan ? signupTrialStatusText(plan) : null;
  const manageableSubscription =
    !launchOffer || hasLiveStripeSubscription(plan?.billing, plan?.currentPeriodEnd);

  return (
    <PageShell
      eyebrow="Mon espace"
      title="Mon compte"
      description="Gérez votre abonnement, votre moyen de paiement et vos données personnelles."
      width="narrow"
    >
      <Card as="section" aria-labelledby="acc-id">
        <h2 id="acc-id" className="text-lg font-semibold text-foreground">
          Connexion
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Adresse email : <strong className="text-foreground">{user?.email ?? "—"}</strong>
        </p>
      </Card>

      <Card as="section" className="mt-6" aria-labelledby="acc-space">
        <h2 id="acc-space" className="text-lg font-semibold text-foreground">
          Mon espace
        </h2>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {spaceLinks.map((link, index) => (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-labelledby={`space-label-${index}`}
                aria-describedby={`space-description-${index}`}
                className="block h-full rounded-lg border border-border px-4 py-3 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
              >
                <span
                  id={`space-label-${index}`}
                  className="block text-sm font-semibold text-foreground"
                >
                  {link.label}
                </span>
                <span
                  id={`space-description-${index}`}
                  className="mt-0.5 block text-xs leading-relaxed text-muted-foreground"
                >
                  {SPACE_DESCRIPTIONS[link.href]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>

      <Card as="section" className="mt-6" aria-labelledby="acc-notifications">
        <h2 id="acc-notifications" className="text-lg font-semibold text-foreground">
          Notifications
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Les nouvelles ventes de vos alertes s’affichent dans la cloche de l’en-tête. L’email
          récapitulatif n’est envoyé que si vous l’activez ici ou depuis la cloche.
        </p>
        {user ? (
          <>
            <AlertEmailRecapToggle userId={user.id} className={TOGGLE_CLASS} />
            <SaleRemindersToggle userId={user.id} className={TOGGLE_CLASS} />
            <SaleResultsToggle userId={user.id} className={TOGGLE_CLASS} />
            <WeeklyDigestToggle userId={user.id} className={TOGGLE_CLASS} />
          </>
        ) : null}
      </Card>

      <Card as="section" className="mt-6" aria-labelledby="acc-investor">
        <h2 id="acc-investor" className="text-lg font-semibold text-foreground">
          Mon profil d’investisseur
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Facultatif. Ces hypothèses préremplissent le calcul de l’enchère plafond de chaque vente ;
          vous les modifiez ensuite vente par vente. Ce sont des simulations : elles ne garantissent
          aucun prix d’adjudication.
        </p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Donnée financière personnelle : elle n’est visible que de vous, jamais envoyée par email
          ni partagée. Elle est effacée avec votre compte, ou dès que vous cliquez sur « Effacer mon
          profil ».
        </p>
        {user ? <InvestorProfileForm userId={user.id} /> : null}
      </Card>

      <Card as="section" className="mt-6" aria-labelledby="acc-sub">
        <h2 id="acc-sub" className="text-lg font-semibold text-foreground">
          Abonnement
        </h2>
        {planQuery.isError ? (
          <p role="alert" className="mt-2 text-sm text-danger">
            Impossible de lire votre abonnement pour le moment. Réessayez dans un instant.
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            Offre actuelle :{" "}
            <strong className="text-foreground">
              {plan
                ? launchOffer
                  ? `${plan.label} · essai gratuit${plan.trialExtension ? " prolongé" : ""}`
                  : plan.label
                : "Chargement…"}
            </strong>
            {plan?.hasAnalysisAccess && periodEnd && !launchOffer ? (
              hasLiveStripeSubscription(plan?.billing, plan?.currentPeriodEnd) && !pastDue ? (
                // Abonnement mensuel : la date est l'échéance (prochain prélèvement, ou fin si
                // l'abonnement est résilié), pas la fin d'un accès à durée fixe.
                <> · abonnement mensuel, prochaine échéance le {periodEnd}</>
              ) : (
                <> · accès jusqu’au {periodEnd}</>
              )
            ) : null}
          </p>
        )}
        {launchOffer ? (
          <p
            role="status"
            data-testid="account-launch-offer"
            className="mt-3 rounded-lg border border-gold/30 bg-gold/10 p-3 text-sm leading-relaxed text-foreground"
          >
            {trialStatus ?? LAUNCH_OFFER_ACCOUNT_TEXT}
          </p>
        ) : trialStatus ? (
          <p
            role="status"
            data-testid="account-trial-ended"
            className="mt-3 rounded-lg border border-border bg-muted/40 p-3 text-sm leading-relaxed text-foreground"
          >
            {trialStatus}
          </p>
        ) : null}
        {pastDue ? (
          <Notice role="status" tone="warning" className="mt-3">
            Votre dernier paiement a échoué. Mettez à jour votre moyen de paiement
            {graceEnd ? <> avant le {graceEnd}</> : null} pour conserver l’accès aux outils Analyse.
          </Notice>
        ) : null}
        {plan && !plan.hasAnalysisAccess ? (
          <div className="mt-3 text-sm text-muted-foreground" data-testid="account-unlocks">
            {unlocksQuery.isError ? (
              <p role="alert" className="text-danger">
                Le suivi de vos déblocages est indisponible pour le moment.
              </p>
            ) : unlockStatus ? (
              unlockStatus.analysisAccess ? null : (
                <p>{unlockUsageLine(unlockStatus)}</p>
              )
            ) : (
              <p>Chargement de vos déblocages…</p>
            )}
          </div>
        ) : null}
        <BillingActions className="mt-4" hideHelper />
        {manageableSubscription ? (
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            « Gérer mon abonnement » ouvre le portail sécurisé Stripe : vous y changez de carte et
            téléchargez vos factures. « Résilier mon abonnement » ouvre directement le formulaire de
            résiliation, à tout moment. La résiliation prend effet à la fin de la période payée.
          </p>
        ) : null}
      </Card>

      {launchOffer && !manageableSubscription ? (
        <AccountLaunchOfferEnd
          endsAt={plan?.trialEndsAt}
          extended={plan?.trialExtension === true}
        />
      ) : null}

      <Card as="section" className="mt-6" aria-labelledby="acc-data">
        <h2 id="acc-data" className="text-lg font-semibold text-foreground">
          Mes données
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Demandez l’accès, la rectification ou l’effacement de vos données, ou exercez votre droit
          de rétractation.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Link href="/mes-droits" className={buttonClasses()}>
            Exercer mes droits
          </Link>
          <Link href="/mes-droits" className={buttonClasses({ variant: "danger" })}>
            Demander la suppression de mon compte
          </Link>
        </div>
      </Card>
    </PageShell>
  );
}
