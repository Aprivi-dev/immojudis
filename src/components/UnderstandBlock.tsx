import Link from "next/link";
import { Card } from "@/components/ui/primitives";
import { EXISTING_GUIDE, type ResourceSummary } from "@/lib/resource-articles";

export type UnderstandLink = {
  href: string;
  label: string;
  /** Précision après le lien, « (12 ventes) » par exemple. */
  detail?: string;
};

/**
 * Bloc « Pour comprendre » des pages département et tribunal : le guide des ventes judiciaires,
 * deux articles à lire avant de miser et, selon la page, les départements limitrophes ou les
 * autres tribunaux du département. Des liens simples vers des pages publiques, sans promesse
 * chiffrée : il sert au lecteur autant qu'au maillage interne.
 */
export function UnderstandBlock({
  articles,
  nearbyTitle,
  nearby,
}: {
  articles: readonly ResourceSummary[];
  nearbyTitle?: string;
  nearby?: readonly UnderstandLink[];
}) {
  return (
    <Card as="section" aria-labelledby="comprendre">
      <h2 id="comprendre" className="font-display text-2xl font-semibold">
        Pour comprendre
      </h2>
      <p className="mt-3 text-ink-soft">
        Une vente judiciaire suit des règles précises : avocat obligatoire, dossier à lire avant la
        visite, frais en plus du prix. Ces pages les expliquent.
      </p>
      <ul className="mt-3 list-disc space-y-1 pl-5">
        <li>
          <Link href={EXISTING_GUIDE.href} className="font-semibold text-gold-text underline">
            Le guide des ventes immobilières judiciaires
          </Link>{" "}
          <span className="text-ink-soft">({EXISTING_GUIDE.readingMinutes} min de lecture)</span>
        </li>
        {articles.map((article) => (
          <li key={article.slug}>
            <Link href={article.href} className="font-semibold text-gold-text underline">
              {article.title}
            </Link>{" "}
            <span className="text-ink-soft">({article.readingMinutes} min de lecture)</span>
          </li>
        ))}
      </ul>
      {nearby?.length ? (
        <>
          <h3 className="mt-5 font-semibold">{nearbyTitle}</h3>
          <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
            {nearby.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="font-semibold text-gold-text underline">
                  {item.label}
                </Link>
                {item.detail ? <span className="text-ink-soft"> {item.detail}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}
