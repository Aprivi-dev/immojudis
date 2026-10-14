import type { Metadata } from "next";
import Link from "next/link";
import { Card, PageShell } from "@/components/ui/primitives";
import { WELL_INFORMED_BADGE_NOTE } from "@/components/WellInformedBadge";
import {
  COMPLETENESS_SCORE_DEFINITION,
  RANKING_EXPLANATION_INTRO,
  RANKING_EXPLANATION_INVESTMENT_NOTE,
  RANKING_EXPLANATION_NOTES,
  RANKING_EXPLANATION_STEPS,
} from "@/components/search/RankingExplanation";
import { publicLegalPublisher } from "@/lib/legal-documents";
import {
  LAWYER_RANKING_HREF,
  LAWYER_RANKING_LINK_LABEL,
  SPONSORED_LABEL,
  SPONSORED_TRIAL_LABEL,
} from "@/lib/lawyer-placement-label";

export const metadata: Metadata = {
  alternates: { canonical: "/classement-des-annonces" },
  title: "Classement des annonces",
  description:
    "Comment Immojudis classe les annonces : ordre par défaut, autres tris, repère « bien renseignée », publicité des avocats, origine et retrait des ventes.",
};

/**
 * Tris proposés dans la liste de résultats de /sales (voir `SORT_OPTIONS`). Le comportement décrit
 * est celui du code: `applySearchOrder` (queries.ts) place toujours les annonces localisées avant
 * les autres côté serveur ; « Nombre de chambres » est ensuite retrié dans chaque page par
 * `sortClientSearchResults` (chambres, à défaut pièces, ordre stable) ; « Distance » est trié côté
 * navigateur à partir de l'adresse saisie, les annonces sans position en dernier.
 */
const SERVER_SORTS = [
  "Date de vente, croissante ou décroissante.",
  "Prix, croissant ou décroissant.",
  "Surface, de la plus grande à la plus petite.",
] as const;

const BEDROOMS_SORT =
  "Nombre de chambres : les pages de résultats sont constituées en affichant d’abord les annonces dont la position sur la carte est connue, puis, dans chaque page, les annonces sont rangées de celles qui comptent le plus de chambres (à défaut, de pièces) à celles qui en comptent le moins, celles sans cette information venant en dernier ; à égalité, l’ordre de la page est conservé.";

const DISTANCE_SORT =
  "Distance, à partir d’une adresse que vous saisissez : les annonces les plus proches de cette adresse d’abord ; celles dont la position est inconnue viennent en dernier.";

export default function Page() {
  const contactEmail = publicLegalPublisher().contactEmail;

  return (
    <PageShell
      eyebrow="Transparence"
      title="Comment sont classées les annonces ?"
      description="L’ordre dans lequel les annonces s’affichent, ce que signifie le repère « Annonce bien renseignée », la publicité des avocats, l’origine des annonces et leur retrait."
      width="narrow"
    >
      <div className="grid gap-5">
        <Card as="section" aria-labelledby="classement-defaut">
          <h2 id="classement-defaut" className="font-display text-2xl font-semibold">
            Le classement par défaut : « Mieux renseignées d’abord »
          </h2>
          <div className="mt-3 space-y-3 text-ink-soft">
            <p>{RANKING_EXPLANATION_INTRO}</p>
            <ol className="list-decimal space-y-2 pl-5">
              {RANKING_EXPLANATION_STEPS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p>{COMPLETENESS_SCORE_DEFINITION}</p>
            {RANKING_EXPLANATION_NOTES.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
        </Card>

        <Card as="section" aria-labelledby="autres-tris">
          <h2 id="autres-tris" className="font-display text-2xl font-semibold">
            Les autres tris
          </h2>
          <div className="mt-3 space-y-3 text-ink-soft">
            <p>
              Depuis la liste de résultats, vous pouvez trier à tout moment par l’un de ces
              critères. Pour les tris par date, prix, surface et score d’investissement, les
              annonces dont la position sur la carte est connue sont affichées avant les autres ; le
              critère choisi les ordonne ensuite, et les annonces auxquelles l’information manque
              viennent en dernier.
            </p>
            <ul className="list-disc space-y-1 pl-5">
              {SERVER_SORTS.map((sort) => (
                <li key={sort}>{sort}</li>
              ))}
              <li>{BEDROOMS_SORT}</li>
              <li>{DISTANCE_SORT}</li>
              <li>
                Score d’investissement, pour l’offre Analyse seulement.{" "}
                {RANKING_EXPLANATION_INVESTMENT_NOTE}
              </li>
            </ul>
          </div>
        </Card>

        <Card as="section" aria-labelledby="bien-renseignee">
          <h2 id="bien-renseignee" className="font-display text-2xl font-semibold">
            Le repère « Annonce bien renseignée »
          </h2>
          <p className="mt-3 text-ink-soft">{WELL_INFORMED_BADGE_NOTE}</p>
        </Card>

        <Card as="section" aria-labelledby="publicite-avocats">
          <h2 id="publicite-avocats" className="font-display text-2xl font-semibold">
            L’encart « {SPONSORED_LABEL} » des avocats
          </h2>
          <div className="mt-3 space-y-3 text-ink-soft">
            <p>
              Parmi les résultats peut apparaître l’encart d’un cabinet d’avocats, annoncé par la
              mention « {SPONSORED_LABEL} » (ou « {SPONSORED_TRIAL_LABEL} » pendant une période
              d’essai de cette offre). C’est une publicité : le cabinet paie Immojudis, ou bénéficie
              d’un essai gratuit de cette offre payante, pour être présenté dans la zone
              géographique de votre recherche.
            </p>
            <p>
              Cet encart n’est ni une recommandation, ni une notation, ni une garantie de résultat.
              Les annonces ne sont ni avancées ni reculées par cet encart.
            </p>
            <p>
              <Link href={LAWYER_RANKING_HREF} className="font-semibold text-gold-text underline">
                {LAWYER_RANKING_LINK_LABEL}
              </Link>
            </p>
          </div>
        </Card>

        <Card as="section" aria-labelledby="origine-annonces">
          <h2 id="origine-annonces" className="font-display text-2xl font-semibold">
            D’où viennent les annonces ?
          </h2>
          <div className="mt-3 space-y-3 text-ink-soft">
            <p>
              Immojudis rassemble des annonces déjà publiées par des tiers : sites d’annonces de
              ventes judiciaires et d’enchères publiques, sites de notaires, portail des cessions
              immobilières de l’État. La fiche indique la ou les sources de chaque annonce, avec un
              lien vers leur publication.
            </p>
            <p>
              Immojudis ne rédige pas ces annonces et ne garantit pas leur exactitude :
              reportez-vous toujours aux pièces officielles de la vente. La couverture varie selon
              les sources.
            </p>
            <p>
              Les professionnels (avocats, notaires, commissaires de justice, tribunaux) disposant
              d’un compte professionnel validé peuvent aussi transmettre une annonce. Elle est
              contrôlée par l’équipe avant publication. Cette transmission ne donne aucune priorité
              de classement à l’annonce.
            </p>
          </div>
        </Card>

        <Card as="section" aria-labelledby="fin-annonce">
          <h2 id="fin-annonce" className="font-display text-2xl font-semibold">
            Quand une annonce n’est-elle plus affichée ?
          </h2>
          <div className="mt-3 space-y-3 text-ink-soft">
            <p>
              Une annonce cesse d’être affichée à l’heure de la vente lorsqu’elle est connue, ou à
              minuit (heure de Paris) le jour de la vente lorsque seule la date l’est. Une vente
              adjugée, annulée ou retirée par sa source n’est plus affichée dans les résultats dès
              que cette information est connue d’Immojudis ; la fiche est ensuite supprimée du
              catalogue en ligne.
            </p>
            <p>
              Une vente reportée reste affichée tant que sa date n’est pas dépassée ; sa nouvelle
              date est mise à jour lorsque la source la publie. Ces mises à jour dépendent des
              publications des sources et de nos contrôles réguliers : un délai est possible.
            </p>
            <p>
              Une annonce peut aussi être retirée du catalogue lorsque l’équipe constate une erreur
              de publication ou une information inexacte ; vous pouvez nous la signaler depuis la
              page Contact (voir ci-dessous).
            </p>
          </div>
        </Card>

        <Card as="section" aria-labelledby="signaler-erreur" className="bg-surface-muted">
          <h2 id="signaler-erreur" className="font-display text-2xl font-semibold">
            Signaler une erreur
          </h2>
          <p className="mt-3 text-ink-soft">
            Une annonce périmée, une information inexacte ou un classement qui vous semble anormal :
            écrivez-nous depuis la page{" "}
            <Link href="/contact" className="font-semibold text-gold-text underline">
              Contact
            </Link>
            {contactEmail ? (
              <>
                {" "}
                ou à{" "}
                <a
                  href={`mailto:${contactEmail}`}
                  className="font-semibold text-gold-text underline"
                >
                  {contactEmail}
                </a>
              </>
            ) : null}
            . Ces règles figurent aussi dans les{" "}
            <Link href="/conditions-generales" className="font-semibold text-gold-text underline">
              conditions générales
            </Link>
            .
          </p>
        </Card>
      </div>
    </PageShell>
  );
}
