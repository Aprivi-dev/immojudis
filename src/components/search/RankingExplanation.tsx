/**
 * Explication du classement par défaut de /sales (« Mieux renseignées d’abord »), affichée à côté
 * des résultats. Le texte décrit TOUS les critères réellement appliqués, dans leur ordre de
 * priorité :
 *   1. les ventes dont la position sur la carte est connue (latitude ET longitude non nulles,
 *      `coordinates_rank`) passent avant les autres ;
 *   2. le palier de complétude de la fiche (`listing-completeness-ranking.ts`) : palier haut si la
 *      classification publiée de la fiche est « décision prête » ou « riche » ;
 *   3. la date de vente, la plus proche d'abord ;
 *   4. l'identifiant, uniquement pour garder un ordre stable d'une page à l'autre (technique,
 *      sans effet visible, non mentionné).
 * Texte relu par la fonction juridique ; toute modification du classement doit le mettre à jour.
 */
export const RANKING_EXPLANATION_TITLE = "Comment sont classées les annonces ?";

export const RANKING_EXPLANATION_INTRO =
  "Par défaut, les annonces sont classées selon trois critères, dans cet ordre.";

export const RANKING_EXPLANATION_STEPS = [
  "Les annonces dont la position sur la carte est connue passent avant les autres.",
  "Elles sont réparties en deux groupes selon la quantité d’informations renseignées dans la fiche Immojudis (par exemple photos, surface, performance énergétique, occupation, visites, documents, description, mise à prix, localisation, contact), appréciée selon le type de bien et la procédure. Le groupe des annonces « bien renseignées » vient en premier : ce sont les fiches dont le bilan d’informations atteint le niveau « décision prête » ou plus.",
  "Dans chaque groupe, la vente la plus proche est affichée en premier.",
] as const;

export const RANKING_EXPLANATION_NOTES = [
  "Une annonce nouvellement publiée est évaluée dans les heures qui suivent.",
  "Ce classement ne juge ni l’intérêt, ni la valeur, ni l’état du bien. Il ne dépend d’aucune rémunération : personne ne peut payer pour améliorer le rang d’une annonce. Un encart d’un cabinet d’avocats, signalé comme mise en avant payante, peut s’intercaler entre deux annonces ; il ne modifie pas leur ordre. Le repère « Annonce bien renseignée » indique une fiche détaillée ; il ne garantit ni l’exactitude des informations ni l’état du bien. Vous pouvez à tout moment trier par date, prix ou surface.",
] as const;

/** Ajouté pour l'offre Analyse seulement, la seule qui voit le tri « Score d’investissement ». */
export const RANKING_EXPLANATION_INVESTMENT_NOTE =
  "Le tri « Score d’investissement » classe selon un indicateur calculé par Immojudis ; c’est une estimation indicative, sans promesse de rendement ni conseil en investissement.";

/**
 * Encart repliable (`<details>`) : natif, accessible au clavier et aux lecteurs d'écran, il
 * fonctionne avant l'hydratation et n'ajoute aucun JavaScript au client.
 */
export function RankingExplanation({ investmentScore = false }: { investmentScore?: boolean }) {
  return (
    <details className="group border-t border-line-soft bg-white px-4 py-2 text-xs text-ink-soft sm:px-5">
      <summary className="inline-flex min-h-8 cursor-pointer items-center font-semibold text-brand-navy underline underline-offset-2 hover:text-gold-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft">
        {RANKING_EXPLANATION_TITLE}
      </summary>
      <div className="mt-1 max-w-3xl space-y-1.5 leading-relaxed">
        <p>{RANKING_EXPLANATION_INTRO}</p>
        <ol className="list-decimal space-y-1 pl-5">
          {RANKING_EXPLANATION_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {RANKING_EXPLANATION_NOTES.map((note) => (
          <p key={note}>{note}</p>
        ))}
        {investmentScore ? <p>{RANKING_EXPLANATION_INVESTMENT_NOTE}</p> : null}
      </div>
    </details>
  );
}
