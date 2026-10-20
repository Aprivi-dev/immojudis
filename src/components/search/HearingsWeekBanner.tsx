import Link from "next/link";

/** Page des audiences des prochains jours (voir `src/app/audiences-a-venir`). */
const HEARINGS_PAGE_PATH = "/audiences-a-venir";

/**
 * Bandeau discret au-dessus des résultats de /sales : un lien vers les audiences de la semaine,
 * jour par jour et tribunal par tribunal. Un simple lien, sans état ni JavaScript : il figure dans
 * le HTML du serveur et ne déplace rien à l'hydratation.
 */
export function HearingsWeekBanner() {
  return (
    <p className="border-t border-line-soft bg-white px-4 py-2 text-xs text-ink-soft sm:px-5">
      <Link
        href={HEARINGS_PAGE_PATH}
        className="inline-flex min-h-8 items-center font-semibold text-brand-navy underline underline-offset-2 hover:text-gold-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
      >
        Audiences de la semaine
      </Link>
      <span>{" : les ventes au tribunal des prochains jours, jour par jour."}</span>
    </p>
  );
}
