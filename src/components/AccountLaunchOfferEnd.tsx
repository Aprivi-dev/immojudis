import { PLAN_LIMITS } from "@/lib/plans";
import { MONTHLY_SALE_UNLOCKS } from "@/lib/sale-unlocks";

/**
 * Ce qui resterait au compte si l'offre de lancement se terminait, dit à l'avance et sans pression :
 * ni date, ni compte à rebours, ni incitation à s'abonner. Les chiffres viennent de `PLAN_LIMITS`.
 * Affiché dans /compte seulement sous l'offre de lancement (compte sans abonnement réel).
 */
export function AccountLaunchOfferEnd() {
  const free = PLAN_LIMITS.decouverte;
  const stays = [
    `${free.favoriteSales} favoris`,
    `${free.watchedZones} alerte avec un email récapitulatif par semaine`,
    `${MONTHLY_SALE_UNLOCKS} déblocages de ventes par mois`,
    "« Mon dossier » : le statut et l’enchère plafond enregistrés sur vos favoris",
  ];
  const needsAnalysis = [
    "le rapport PDF",
    "l’estimation détaillée et les ventes comparables",
    "les pièces du dossier et leur lecture sur toutes les ventes (avec le compte gratuit : les déblocages du mois)",
    "les exports (PDF et CSV) et les rapports enregistrés",
  ];
  return (
    <section
      className="mt-6 rounded-xl border border-border bg-card p-5"
      aria-labelledby="acc-offer-end"
      data-testid="account-offer-end"
    >
      <h2 id="acc-offer-end" className="text-lg font-semibold text-foreground">
        Si l’offre de lancement se terminait
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        Aucune date n’est annoncée sur cette page. Si l’offre se termine, vos données ne sont pas
        supprimées (favoris, alertes, rapports enregistrés) : certaines fonctions se ferment, et ce
        que vous avez créé se rouvre avec l’offre Analyse.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Ce qui reste gratuit</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground">
            {stays.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            Ce qui demandera l’offre Analyse
          </h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground">
            {needsAnalysis.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
