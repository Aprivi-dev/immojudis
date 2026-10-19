"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import Bell from "lucide-react/dist/esm/icons/bell.js";
import { Badge, Button, Card, buttonClasses } from "@/components/ui/primitives";
import { useAuth } from "@/hooks/use-auth";
import { useCreateAlert } from "@/hooks/use-create-alert";
import { useHasAnalysisAccess } from "@/hooks/use-has-analysis-access";
import { alertCriteriaSummary } from "@/lib/alert-criteria-labels";
import { FEES_SIMULATOR_DEPARTMENTS } from "@/components/fees-simulator/departments";
import { alertCreationPath, publicAlertCriteria } from "@/lib/discovery-alerts";
import type { SalesSearchUrlRecord } from "@/lib/search/search-url-state";

/**
 * Création d'une alerte pour un secteur (département…) depuis une page publique ou la page de
 * confirmation : les critères sont rappelés, l'email récapitulatif est une case NON cochée et la
 * création se fait en un clic. À utiliser seulement pour une personne connectée (le visiteur
 * passe par `SectorAlertCta`, puis par la connexion).
 */
export function SectorAlertForm({
  criteria,
  title = "Être prévenu des nouvelles ventes de ce secteur",
  intro,
  actionLabel = "Créer l’alerte",
}: {
  criteria: SalesSearchUrlRecord;
  title?: string;
  intro?: string;
  /** Libellé du bouton qui crée l'alerte. */
  actionLabel?: string;
}) {
  const checkboxId = useId();
  const { user } = useAuth();
  const hasAnalysisAccess = useHasAnalysisAccess(user?.id);
  const search = useMemo(() => publicAlertCriteria(criteria), [criteria]);
  const summary = useMemo(() => {
    const department = FEES_SIMULATOR_DEPARTMENTS.find(({ code }) => code === search.department);
    return alertCriteriaSummary({
      department: department
        ? `${department.name} (${department.code})`
        : (search.department ?? null),
      city: search.city ?? null,
      property_type: search.homeTypes?.[0] ?? null,
      max_price_eur: search.maxPrice ?? null,
      min_surface_m2: search.minSqft ?? null,
      occupancy_status: null,
      min_investment_score: null,
      max_price_per_m2: null,
      min_yield_pct: null,
      min_market_discount_pct: null,
      dpe_classes: [],
      require_house_with_land: false,
      advanced_criteria: { sale_type: search.saleType },
    });
  }, [search]);
  const { createAlertFromSearch, saving } = useCreateAlert({
    returnTo: alertCreationPath(criteria),
  });
  // Jamais pré-cochée : l'email part seulement si la personne le demande.
  const [emailRecap, setEmailRecap] = useState(false);
  const [created, setCreated] = useState(false);

  if (created) {
    return (
      <Card role="status" className="grid gap-3">
        <p className="font-semibold">Alerte créée.</p>
        <p className="text-sm text-ink-soft">
          {emailRecap
            ? "Les nouvelles ventes de ce secteur arriveront aussi dans votre email récapitulatif."
            : "Les nouvelles ventes de ce secteur apparaîtront dans vos alertes."}{" "}
          Vous pouvez la modifier ou la supprimer à tout moment.
        </p>
        <div>
          <Link href="/alertes" className={buttonClasses({ variant: "primary" })}>
            Voir mes alertes
          </Link>
        </div>
      </Card>
    );
  }

  async function create() {
    const result = await createAlertFromSearch(search, {
      emailRecap,
      // L'offre Analyse reçoit un récapitulatif quotidien, l'offre gratuite un par semaine.
      frequency: hasAnalysisAccess ? "daily" : "weekly",
    });
    if (result.status === "created") setCreated(true);
  }

  return (
    <Card as="section" aria-label={title} className="grid gap-3">
      <h2 className="flex items-center gap-2 font-display text-2xl font-semibold">
        <Bell className="size-5 text-gold-text" aria-hidden />
        {title}
      </h2>
      {intro ? <p className="text-sm text-ink-soft">{intro}</p> : null}
      {summary.length > 0 ? (
        <ul aria-label="Critères de l'alerte" className="flex flex-wrap gap-2">
          {summary.map((criterion) => (
            <li key={criterion}>
              <Badge>{criterion}</Badge>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-start gap-3">
        <input
          id={checkboxId}
          type="checkbox"
          checked={emailRecap}
          onChange={(event) => setEmailRecap(event.target.checked)}
          className="mt-1 size-5 shrink-0 accent-[var(--gold)]"
        />
        <label htmlFor={checkboxId} className="min-h-11 text-sm">
          <span className="font-semibold">
            Recevoir aussi un email récapitulatif (
            {hasAnalysisAccess ? "un par jour" : "un par semaine"})
          </span>
          <span className="block text-ink-soft">
            Facultatif. Vous pouvez le désactiver à tout moment depuis votre compte ou le lien de
            désinscription de chaque email.
          </span>
        </label>
      </div>
      <div>
        <Button variant="primary" disabled={saving} onClick={() => void create()}>
          {saving ? "Création…" : actionLabel}
        </Button>
      </div>
    </Card>
  );
}
