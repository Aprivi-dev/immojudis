import type { Metadata } from "next";
import Link from "next/link";
import { HighlightedFigure } from "@/components/departments/HighlightedFigure";
import { BuyingSteps } from "@/components/sale-landing/BuyingSteps";
import { SaleLandingSection, SaleLandingView } from "@/components/sale-landing/SaleLandingView";
import { SALE_LANDING_PAGES, saleLandingMetadata } from "@/lib/sale-landing-pages";
import { loadSaleLandingForPage } from "@/lib/sale-landing-pages.server";

// Comme `/audiences-a-venir` : page rendue à l'avance, servie depuis le cache et rafraîchie au plus
// toutes les heures. Next.js veut un littéral ici ; il doit rester égal à
// SALE_LANDING_REVALIDATE_SECONDS (un test le vérifie).
export const revalidate = 3600;

const PAGE = SALE_LANDING_PAGES.apartment;

const count = new Intl.NumberFormat("fr-FR");

export async function generateMetadata(): Promise<Metadata> {
  const data = await loadSaleLandingForPage(PAGE.key);
  return saleLandingMetadata(
    PAGE,
    {
      title: "Appartement aux enchères : les ventes à venir",
      description:
        "Appartements aux enchères à venir au tribunal, chez le notaire ou vendus par l’État : dates, prix publiés et étapes pour acheter un appartement aux enchères.",
    },
    data?.upcomingCount ?? null,
  );
}

function Heading({ total }: { total: number | null }) {
  if (total == null) return <>Appartements aux enchères</>;
  if (total === 0) return <>Aucun appartement aux enchères à venir pour le moment.</>;
  return (
    <>
      <HighlightedFigure>{count.format(total)}</HighlightedFigure>{" "}
      {total > 1 ? "appartements aux enchères à venir." : "appartement aux enchères à venir."}
    </>
  );
}

export default async function Page() {
  const data = await loadSaleLandingForPage(PAGE.key);
  return (
    <SaleLandingView
      page={PAGE}
      data={data}
      eyebrow="Ventes aux enchères · Appartements"
      heading={<Heading total={data?.upcomingCount ?? null} />}
      intro="Les appartements mis en vente au tribunal, chez le notaire ou par l’État, et référencés par Immojudis."
      articleSlugs={[
        "copropriete-encheres-charges-assemblees",
        "acheter-bien-occupe-encheres",
        "dpe-diagnostics-travaux-bien-energivore-plafond",
        "frais-vente-encheres-judiciaire",
      ]}
    >
      <SaleLandingSection id="acheter" title="Acheter un appartement aux enchères : les étapes">
        <BuyingSteps />
      </SaleLandingSection>
      <SaleLandingSection id="verifier" title="Les points à vérifier pour un appartement">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>La copropriété.</strong> Pour la vente publique d’un lot d’habitation, les
            documents sur l’organisation et les finances de l’immeuble doivent être annexés au
            cahier des charges : réclamez-les avant d’enchérir. Des travaux votés avant la vente
            mais appelés après peuvent revenir à l’acheteur.
          </li>
          <li>
            <strong>L’occupation.</strong> Un appartement peut être vendu occupé, par son
            propriétaire ou par un locataire. Le cahier des conditions de vente le précise :
            lisez-le avant d’enchérir.
          </li>
          <li>
            <strong>L’état du logement.</strong> Diagnostics (dont le DPE) et travaux à prévoir,
            dans l’appartement comme dans les parties communes : ils pèsent sur le budget autant que
            le prix.
          </li>
        </ul>
        <p>
          Vous cherchez plutôt une maison ?{" "}
          <Link
            href={SALE_LANDING_PAGES.house.path}
            className="font-semibold text-gold-text underline"
          >
            Voir les maisons aux enchères
          </Link>
          .
        </p>
      </SaleLandingSection>
    </SaleLandingView>
  );
}
