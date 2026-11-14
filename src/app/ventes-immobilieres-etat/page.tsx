import type { Metadata } from "next";
import Link from "next/link";
import { HighlightedFigure } from "@/components/departments/HighlightedFigure";
import { SaleLandingSection, SaleLandingView } from "@/components/sale-landing/SaleLandingView";
import { getResourceArticle } from "@/lib/resource-articles";
import { SALE_LANDING_PAGES, saleLandingMetadata } from "@/lib/sale-landing-pages";
import { loadSaleLandingForPage } from "@/lib/sale-landing-pages.server";

// Comme `/audiences-a-venir` : page rendue à l'avance, servie depuis le cache et rafraîchie au plus
// toutes les heures. Next.js veut un littéral ici ; il doit rester égal à
// SALE_LANDING_REVALIDATE_SECONDS (un test le vérifie).
export const revalidate = 3600;

const PAGE = SALE_LANDING_PAGES.state;

/** L'article qui compare le tribunal, le notaire et l'État (articles du CGPPP cités). */
const SALE_TYPES_ARTICLE_SLUG = "ventes-notariales-domaniales-differences-tribunal";

/**
 * Site officiel des ventes aux enchères du Domaine (véhicules, matériel…), que le site des cessions
 * immobilières de l'État cite dans ses liens utiles. Immojudis ne référence pas ces ventes mobilières.
 */
const DOMAINE_MOVABLE_SALES_URL = "https://encheres-domaine.gouv.fr/";

const count = new Intl.NumberFormat("fr-FR");

const TEXT_LINK = "font-semibold text-gold-text underline";

export async function generateMetadata(): Promise<Metadata> {
  const data = await loadSaleLandingForPage(PAGE.key);
  return saleLandingMetadata(
    PAGE,
    {
      // Sans le suffixe du site : 60 caractères avec lui. Le titre ne promet pas d'enchères.
      title: "Ventes domaniales immobilières : biens de l’État",
      description:
        "Biens immobiliers mis en vente par l’État : adjudication, appel d’offres ou vente amiable. Les ventes à venir référencées et ce qu’il faut vérifier.",
    },
    data?.upcomingCount ?? null,
  );
}

function Heading({ total }: { total: number | null }) {
  if (total == null) return <>Ventes immobilières de l’État</>;
  if (total === 0) {
    return <>Ventes immobilières de l’État : aucun bien en vente référencé pour le moment.</>;
  }
  return (
    <>
      Ventes immobilières de l’État : <HighlightedFigure>{count.format(total)}</HighlightedFigure>{" "}
      {total > 1 ? "biens en vente." : "bien en vente."}
    </>
  );
}

export default async function Page() {
  const data = await loadSaleLandingForPage(PAGE.key);
  const article = getResourceArticle(SALE_TYPES_ARTICLE_SLUG);
  return (
    <SaleLandingView
      page={PAGE}
      data={data}
      eyebrow="Ventes domaniales · Immobilier"
      heading={<Heading total={data?.upcomingCount ?? null} />}
      intro="Les biens immobiliers mis en vente par l’État et référencés par Immojudis. Toutes ces ventes ne sont pas des enchères : chaque fiche indique le mode de cession quand l’annonce le publie."
      articleSlugs={[SALE_TYPES_ARTICLE_SLUG]}
    >
      <SaleLandingSection
        id="procedures"
        title="Ventes domaniales : adjudication, appel d’offres ou vente amiable"
      >
        <p>
          L’État peut vendre les immeubles de son domaine privé qui ne sont plus utilisés par un
          service public (art. L. 3211-1 du Code général de la propriété des personnes publiques).
          La vente se fait avec publicité et mise en concurrence, soit par adjudication publique,
          c’est-à-dire aux enchères, soit à l’amiable, après un avis qui précise comment présenter
          une offre (art. R. 3211-2).
        </p>
        <p>
          Une annonce de l’État peut donc mener à des enchères, en salle ou en ligne, à un appel
          d’offres ou à une vente de gré à gré. Vérifiez le mode de cession avant de préparer une
          offre : un appel d’offres ou une vente amiable n’est pas une vente aux enchères.
        </p>
      </SaleLandingSection>
      <SaleLandingSection
        id="sources"
        title="Ce que cette page couvre, et ce qu’elle ne couvre pas"
      >
        <p>
          Les ventes listées viennent du site officiel des cessions immobilières de l’État et,
          lorsque l’annonce désigne une vente de l’État, d’autres sources publiques, comme les biens
          confisqués vendus par l’AGRASC (Agence de gestion et de recouvrement des avoirs saisis et
          confisqués). Chaque fiche indique sa source.
        </p>
        <p>
          Les ventes mobilières du Domaine (véhicules, matériel et autres objets) ne sont pas sur
          Immojudis, qui ne référence que de l’immobilier. Elles sont publiées sur le site officiel
          des ventes aux enchères du Domaine,{" "}
          <a
            href={DOMAINE_MOVABLE_SALES_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={TEXT_LINK}
          >
            encheres-domaine.gouv.fr
          </a>
          .
        </p>
      </SaleLandingSection>
      <SaleLandingSection id="verifier" title="Avant de vous engager">
        <p>
          Le cahier des charges de chaque vente fixe la garantie, le délai de paiement et les frais
          : demandez-le au service vendeur avant toute offre. Un acquéreur qui ne paie pas aux
          échéances peut être déchu de la vente après une mise en demeure d’un mois (art. R.
          3211-8).
        </p>
        {article ? (
          <p>
            Les différences avec une vente au tribunal ou chez le notaire sont détaillées dans
            l’article{" "}
            <Link href={article.href} className={TEXT_LINK}>
              «&nbsp;{article.title}&nbsp;»
            </Link>
            .
          </p>
        ) : null}
      </SaleLandingSection>
    </SaleLandingView>
  );
}
