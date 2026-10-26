import Link from "next/link";
import { PEPITE_METHOD_LINK_LABEL, PEPITE_METHOD_PATH } from "@/lib/pepite-copy";

/** Page publique qui détaille le classement, le repère « Annonce bien renseignée » et la publicité. */
export const RANKING_PAGE_PATH = "/classement-des-annonces";

/**
 * Explication du classement par défaut de /sales (« Mieux renseignées d’abord »), affichée à côté
 * des résultats. Le texte décrit TOUS les critères réellement appliqués, dans leur ordre de
 * priorité :
 *   1. les ventes dont la position sur la carte est connue (latitude ET longitude non nulles,
 *      `coordinates_rank`) passent avant les autres ;
 *   2. le palier de complétude de la fiche (`listing-completeness-ranking.ts`) : palier haut si son
 *      score de complétude est d'au moins 40 sur 100 (`highTierMinScore`) ;
 *   3. la date de vente, la plus proche d'abord ;
 *   4. l'identifiant, uniquement pour garder un ordre stable d'une page à l'autre (technique,
 *      sans effet visible, non mentionné).
 * Texte relu par la fonction juridique ; toute modification du classement doit le mettre à jour.
 */
export const RANKING_EXPLANATION_TITLE = "Comment sont classées les annonces ?";

/** Définition du score de complétude, affichée sur la page publique du classement. */
export const COMPLETENESS_SCORE_DEFINITION =
  "Le score de complétude mesure, sur 100, la part des informations utiles renseignées dans la fiche Immojudis, appuyées par une source ; il ne juge ni l’intérêt ni la valeur du bien.";

export const RANKING_EXPLANATION_INTRO =
  "Par défaut, les annonces sont classées selon trois critères, dans cet ordre.";

export const RANKING_EXPLANATION_STEPS = [
  "Les annonces dont la position sur la carte est connue passent avant les autres.",
  "Elles sont réparties en deux groupes selon la quantité d’informations renseignées dans la fiche Immojudis (par exemple photos, surface, performance énergétique, occupation, visites, documents, description, mise à prix, localisation, contact), appréciée selon le type de bien et la procédure. Le groupe des annonces portant le repère « Annonce bien renseignée » (score de complétude d’au moins 40 sur 100) vient en premier.",
  "Dans chaque groupe, la vente la plus proche est affichée en premier.",
] as const;

export const RANKING_EXPLANATION_NOTES = [
  "Une annonce nouvellement publiée est évaluée dans les heures qui suivent.",
  "Ce classement ne juge ni l’intérêt, ni la valeur, ni l’état du bien.",
  "L’ordre des annonces ne dépend d’aucune rémunération. Un encart de cabinet d’avocats, signalé comme publicité, peut s’intercaler entre deux annonces sans modifier leur ordre.",
  "Le repère « Annonce bien renseignée » signale une fiche qui réunit une part importante des informations que nous relevons (score d’au moins 40 sur 100) ; il ne garantit ni leur exactitude ni l’état du bien. Vous pouvez à tout moment trier par date, prix ou surface.",
] as const;

/** Ajouté pour l'offre Analyse seulement, la seule qui voit le tri « Score d’investissement ». */
export const RANKING_EXPLANATION_INVESTMENT_NOTE =
  "Le tri « Score d’investissement » classe selon un indicateur calculé par Immojudis ; c’est une estimation indicative, sans promesse de rendement ni conseil en investissement.";

/**
 * Note partagée sur le repère « Pépite » (proposition n° 21) : il n'entre dans aucun tri. Affichée seulement
 * quand le repère est ouvert au public (`pepites`), pour ne rien changer de visible tant qu'il ne l'est pas.
 */
export const RANKING_PEPITE_NOTE =
  "Le repère « Pépite » ne change ni l’ordre par défaut ni les autres tris.";

/**
 * Encart repliable (`<details>`) : natif, accessible au clavier et aux lecteurs d'écran, il
 * fonctionne avant l'hydratation et n'ajoute aucun JavaScript au client.
 */
export function RankingExplanation({
  investmentScore = false,
  inline = false,
  pepites = false,
}: {
  investmentScore?: boolean;
  /** Le repère « Pépite » est ouvert au public : sa note d'indépendance de l'ordre s'ajoute. */
  pepites?: boolean;
  /** Dans la ligne d'aide sous le titre des résultats : ouvert, l'encart prend toute la largeur. */
  inline?: boolean;
}) {
  return (
    <details
      className={
        inline
          ? "group text-xs text-ink-soft open:basis-full"
          : "group border-t border-line-soft bg-white px-4 py-2 text-xs text-ink-soft sm:px-5"
      }
    >
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
        {pepites ? (
          <p>
            {RANKING_PEPITE_NOTE}{" "}
            <Link
              href={PEPITE_METHOD_PATH}
              className="font-semibold text-brand-navy underline underline-offset-2 hover:text-gold-text"
            >
              {PEPITE_METHOD_LINK_LABEL}
            </Link>
          </p>
        ) : null}
        <p>
          <Link
            href={RANKING_PAGE_PATH}
            className="font-semibold text-brand-navy underline underline-offset-2 hover:text-gold-text"
          >
            En savoir plus
          </Link>
        </p>
      </div>
    </details>
  );
}
