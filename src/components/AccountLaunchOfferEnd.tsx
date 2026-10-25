import { LAUNCH_OFFER_DATA_TEXT, LAUNCH_OFFER_DURATION_TEXT } from "@/lib/launch-offer";
import {
  LAUNCH_OFFER_END_NEEDS_ANALYSIS,
  LAUNCH_OFFER_END_STAYS,
} from "@/lib/launch-offer-end-lists";

/**
 * Ce qui restera au compte à la fin de son essai gratuit, dit à l'avance et sans pression : ni compte
 * à rebours, ni incitation à s'abonner (la date est dans le bloc « Abonnement »). Les listes sont
 * celles de `launch-offer-end-lists.ts`.
 * Affiché dans /compte seulement pendant l'essai (compte sans abonnement réel).
 */
export function AccountLaunchOfferEnd() {
  const stays = LAUNCH_OFFER_END_STAYS;
  const needsAnalysis = LAUNCH_OFFER_END_NEEDS_ANALYSIS;
  return (
    <section
      className="mt-6 rounded-xl border border-border bg-card p-5"
      aria-labelledby="acc-offer-end"
      data-testid="account-offer-end"
    >
      <h2 id="acc-offer-end" className="text-lg font-semibold text-foreground">
        À la fin de votre essai
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {LAUNCH_OFFER_DURATION_TEXT}
      </p>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {LAUNCH_OFFER_DATA_TEXT} Les fonctions qui se ferment à la fin de l’essai sont listées
        ci-dessous.
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
