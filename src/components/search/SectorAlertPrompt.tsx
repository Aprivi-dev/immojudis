import { SaveSearchButton, type SaveSearchOptions } from "./SearchHeader";

/** En dessous de ce nombre de ventes, la recherche propose d'être prévenu des nouvelles. */
export const FEW_RESULTS_ALERT_THRESHOLD = 5;

/**
 * Sous les résultats vides ou peu nombreux : « Recevoir les nouvelles ventes de ce secteur ».
 * C'est le bouton d'alerte du catalogue (fréquence et case « email récapitulatif » non cochée
 * dans la fenêtre qui s'ouvre) ; un visiteur passe par la connexion et revient sur cette
 * recherche, ses filtres intacts.
 */
export function SectorAlertPrompt({
  resultCount,
  saving,
  signedIn,
  dailyAllowed,
  emailRecapEnabled,
  onSaveSearch,
}: {
  resultCount: number;
  saving: boolean;
  signedIn: boolean;
  dailyAllowed: boolean;
  emailRecapEnabled: boolean;
  onSaveSearch: (options?: SaveSearchOptions) => void;
}) {
  return (
    <section
      aria-label="Être prévenu des nouvelles ventes"
      className="mx-3 mb-6 rounded-md border border-line-soft bg-white p-4 shadow-sm sm:mx-5"
    >
      <p className="text-sm font-semibold text-brand-navy">
        {resultCount === 0
          ? "Rien pour ces critères aujourd’hui."
          : `Seulement ${resultCount} ${resultCount > 1 ? "ventes correspondent" : "vente correspond"} à ces critères.`}
      </p>
      <p className="mt-1 text-sm text-ink-soft">
        Les ventes sont référencées au fil des publications : recevez les nouvelles dès qu’elles
        correspondent à votre recherche.
      </p>
      <div className="mt-3">
        <SaveSearchButton
          saving={saving}
          signedIn={signedIn}
          dailyAllowed={dailyAllowed}
          emailRecapEnabled={emailRecapEnabled}
          label="Recevoir les nouvelles ventes de ce secteur"
          onClick={onSaveSearch}
        />
      </div>
    </section>
  );
}
