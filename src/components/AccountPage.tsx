"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { BillingActions } from "@/components/BillingActions";
import { useAuth } from "@/hooks/use-auth";
import { fetchAccessPlan } from "@/lib/client-billing";

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
  const pastDue = plan?.billing?.status === "past_due";
  const graceEnd = formatDate(plan?.billing?.graceEndsAt);
  const periodEnd = formatDate(plan?.currentPeriodEnd);

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16 pt-28 sm:px-6">
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
        <BillingActions className="mt-4" hideHelper />
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Le bouton ouvre le portail sécurisé Stripe : vous y changez de carte, téléchargez vos
          factures et résiliez à tout moment. La résiliation prend effet à la fin de la période
          payée.
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
