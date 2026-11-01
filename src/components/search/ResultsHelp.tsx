import Link from "next/link";
import { HearingsWeekBanner } from "./HearingsWeekBanner";
import { RankingExplanation } from "./RankingExplanation";

/** Page qui explique les types de vente (tribunal, notaire, domaniales). */
export const SALE_TYPES_HELP_PATH = "/ventes-immobilieres-judiciaires#differences";

/**
 * Aide à la lecture des résultats, au pied de la liste : les trois liens qui occupaient une ligne
 * (et parfois deux, sur mobile) avant la première annonce. « Quelle différence entre les types de
 * vente ? », « Audiences de la semaine » et « Comment sont classées les annonces ? » restent à un
 * défilement, sans repousser les annonces sous la ligne de flottaison.
 */
export function ResultsHelp({
  investmentScore = false,
  pepites = false,
}: {
  investmentScore?: boolean;
  pepites?: boolean;
}) {
  return (
    <section
      aria-label="Aide à la lecture des résultats"
      className="mx-3 mt-4 flex flex-wrap items-start gap-x-5 gap-y-1 border-t border-line-soft pt-3 text-xs text-ink-soft sm:mx-5"
    >
      <Link
        href={SALE_TYPES_HELP_PATH}
        // Affiché sur chaque visite de /sales : pas de préchargement de la page d'explication.
        prefetch={false}
        className="inline-flex min-h-8 items-center font-semibold text-brand-navy underline underline-offset-2 hover:text-gold-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
      >
        Quelle différence entre les types de vente ?
      </Link>
      <HearingsWeekBanner inline />
      <RankingExplanation investmentScore={investmentScore} pepites={pepites} inline />
    </section>
  );
}
