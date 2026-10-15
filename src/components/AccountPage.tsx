"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { BillingActions } from "@/components/BillingActions";
import { useAuth } from "@/hooks/use-auth";
import { fetchSaleUnlocksOverview } from "@/lib/client-api";
import { fetchAccessPlan } from "@/lib/client-billing";
import { queryKeys } from "@/lib/query-keys";
import { unlockUsageLine } from "@/lib/sale-unlocks";

const dateFormat = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : dateFormat.format(date);
}

export function AccountPage() {
  const { user } = useAuth();
  const planQuery = useQuery({
    queryKey: ["feature-entitlements", user?.id ?? "anonymous", "plan"],
    queryFn: fetchAccessPlan,
    enabled: Boolean(user),
    staleTime: 60_000,
  });
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
  const pastDue = plan?.billing?.status === "past_due";
  const graceEnd = formatDate(plan?.billing?.graceEndsAt);
  const periodEnd = formatDate(plan?.currentPeriodEnd);

  return (
    <main id="contenu" className="mx-auto max-w-3xl px-4 pb-16 pt-28 sm:px-6">
      <h1 className="font-display text-4xl text-foreground">Mon compte</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Gérez votre abonnement, votre moyen de paiement et vos données personnelles.
      </p>

      <section
        className="mt-8 rounded-xl border border-border bg-card p-5"
        aria-labelledby="acc-id"
      >
        <h2 id="acc-id" className="text-lg font-semibold text-foreground">
          Connexion
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Adresse email : <strong className="text-foreground">{user?.email ?? "—"}</strong>
        </p>
      </section>

      <section
        className="mt-6 rounded-xl border border-border bg-card p-5"
        aria-labelledby="acc-sub"
      >
        <h2 id="acc-sub" className="text-lg font-semibold text-foreground">
          Abonnement
        </h2>
        {planQuery.isError ? (
          <p role="alert" className="mt-2 text-sm text-red-700">
            Impossible de lire votre abonnement pour le moment. Réessayez dans un instant.
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            Offre actuelle :{" "}
            <strong className="text-foreground">{plan ? plan.label : "Chargement…"}</strong>
            {plan?.hasAnalysisAccess && periodEnd ? <> · accès jusqu’au {periodEnd}</> : null}
          </p>
        )}
        {pastDue ? (
          <p
            role="status"
            className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
          >
            Votre dernier paiement a échoué. Mettez à jour votre moyen de paiement
            {graceEnd ? <> avant le {graceEnd}</> : null} pour conserver l’accès aux outils Analyse.
          </p>
        ) : null}
        {plan && !plan.hasAnalysisAccess ? (
          <div className="mt-3 text-sm text-muted-foreground" data-testid="account-unlocks">
            {unlocksQuery.isError ? (
              <p role="alert" className="text-red-700">
                Le suivi de vos déblocages est indisponible pour le moment.
              </p>
            ) : unlockStatus ? (
              unlockStatus.analysisAccess ? null : (
                <p>{unlockUsageLine(unlockStatus)}</p>
              )
            ) : (
              <p>Chargement de vos déblocages…</p>
            )}
            <Link
              href="/compte/ventes-debloquees"
              className="mt-1 inline-flex min-h-11 items-center font-semibold text-gold-text underline underline-offset-4"
            >
              Mes ventes débloquées
            </Link>
          </div>
        ) : null}
        <BillingActions className="mt-4" hideHelper />
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          « Gérer mon abonnement » ouvre le portail sécurisé Stripe : vous y changez de carte et
          téléchargez vos factures. « Résilier mon abonnement » ouvre directement le formulaire de
          résiliation, à tout moment. La résiliation prend effet à la fin de la période payée.
        </p>
      </section>

      <section
        className="mt-6 rounded-xl border border-border bg-card p-5"
        aria-labelledby="acc-data"
      >
        <h2 id="acc-data" className="text-lg font-semibold text-foreground">
          Mes données
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Demandez l’accès, la rectification ou l’effacement de vos données, ou exercez votre droit
          de rétractation.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Link
            href="/mes-droits"
            className="inline-flex rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground hover:bg-muted"
          >
            Exercer mes droits
          </Link>
          <Link
            href="/mes-droits"
            className="inline-flex rounded-lg border border-red-300 px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50"
          >
            Demander la suppression de mon compte
          </Link>
        </div>
      </section>
    </main>
  );
}
