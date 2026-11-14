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

const PAGE = SALE_LANDING_PAGES.notary;

/** L'article qui compare le tribunal, le notaire et l'État (faits sourcés : Notaires de France). */
const SALE_TYPES_ARTICLE_SLUG = "ventes-notariales-domaniales-differences-tribunal";

/** Site des notaires : les annonces classiques de gré à gré, qu'Immojudis ne liste pas. */
const NOTARIES_LISTINGS_URL = "https://www.immobilier.notaires.fr/";

const count = new Intl.NumberFormat("fr-FR");

const TEXT_LINK = "font-semibold text-gold-text underline";

export async function generateMetadata(): Promise<Metadata> {
  const data = await loadSaleLandingForPage(PAGE.key);
  return saleLandingMetadata(
    PAGE,
    {
      title: "Enchères notariales : biens immobiliers à venir",
      description:
        "Les ventes immobilières des notaires à venir : enchères à la bougie et ventes interactives en ligne, et ce qui les distingue d’une annonce classique.",
    },
    data?.upcomingCount ?? null,
  );
}

function Heading({ total }: { total: number | null }) {
  if (total == null) return <>Enchères notariales</>;
  if (total === 0) return <>Enchères notariales : aucune vente à venir pour le moment.</>;
  return (
    <>
      Enchères notariales : <HighlightedFigure>{count.format(total)}</HighlightedFigure>{" "}
      {total > 1 ? "ventes immobilières à venir." : "vente immobilière à venir."}
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
      eyebrow="Ventes chez le notaire"
      heading={<Heading total={data?.upcomingCount ?? null} />}
      intro="Les ventes immobilières organisées par des notaires et référencées par Immojudis : ventes aux enchères et ventes notariales interactives."
      articleSlugs={[SALE_TYPES_ARTICLE_SLUG, "frais-vente-encheres-judiciaire"]}
    >
      <SaleLandingSection
        id="formules"
        title="Bougie, vente interactive ou annonce classique : trois façons de vendre chez le notaire"
      >
        <p>
          <strong>La vente aux enchères à la bougie.</strong> De vraies enchères, en salle. Selon
          Notaires de France, l’adjudication est prononcée quand deux feux successifs s’éteignent
          sans nouvelle enchère ; le procès-verbal d’adjudication sert d’acte de vente. Le cahier
          des charges de la vente indique la consignation à remettre avant d’enchérir et les frais à
          prévoir.
        </p>
        <p>
          <strong>La vente notariale interactive.</strong> Une vente en ligne, par offres, pendant
          une période limitée. Ce n’est pas une adjudication : l’offre retenue, dont le choix dépend
          du vendeur et des conditions du service, mène à un avant-contrat signé chez le notaire.
        </p>
        <p>
          <strong>L’annonce classique de gré à gré.</strong> Le bien est proposé à un prix affiché
          et se négocie avec le vendeur, sans enchères ni période d’offres. Immojudis ne liste pas
          ces annonces : elles sont publiées sur le site immobilier des notaires,{" "}
          <a
            href={NOTARIES_LISTINGS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={TEXT_LINK}
          >
            immobilier.notaires.fr
          </a>
          .
        </p>
        <p>
          Une vente organisée par un notaire n’est pas forcément volontaire : un notaire peut aussi
          recevoir des enchères ordonnées par un tribunal. Les règles du Code de procédure civile
          s’appliquent alors, avec la possibilité d’enchérir sans avocat (art. 1278).
        </p>
      </SaleLandingSection>
      <SaleLandingSection id="avant" title="Avant de participer à une vente notariale">
        <p>Demandez au notaire, pour la vente qui vous intéresse :</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            la formule : enchères avec adjudication, ou vente interactive par offres avec
            avant-contrat ;
          </li>
          <li>la consignation ou la garantie demandée, et sous quelle forme ;</li>
          <li>les frais : compris dans le prix annoncé, ou en plus ;</li>
          <li>les dates de visite, et si le bien est occupé.</li>
        </ul>
        {article ? (
          <p>
            Le comparatif complet du tribunal, du notaire et de l’État est dans l’article{" "}
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
