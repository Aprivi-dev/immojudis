import type { Metadata } from "next";
import Link from "next/link";
import { HighlightedFigure } from "@/components/departments/HighlightedFigure";
import { SaleLandingSection, SaleLandingView } from "@/components/sale-landing/SaleLandingView";
import { BuyingSteps } from "@/components/sale-landing/BuyingSteps";
import { SALE_LANDING_PAGES, saleLandingMetadata } from "@/lib/sale-landing-pages";
import { loadSaleLandingForPage } from "@/lib/sale-landing-pages.server";

// Comme `/audiences-a-venir` : page rendue à l'avance, servie depuis le cache et rafraîchie au plus
// toutes les heures. Next.js veut un littéral ici ; il doit rester égal à
// SALE_LANDING_REVALIDATE_SECONDS (un test le vérifie).
export const revalidate = 3600;

const PAGE = SALE_LANDING_PAGES.house;

const count = new Intl.NumberFormat("fr-FR");

export async function generateMetadata(): Promise<Metadata> {
  const data = await loadSaleLandingForPage(PAGE.key);
  return saleLandingMetadata(
    PAGE,
    {
      title: "Maison aux enchères : les ventes à venir",
      description:
        "Maisons aux enchères à venir au tribunal, chez le notaire ou vendues par l’État : dates, prix publiés et étapes pour acheter une maison aux enchères.",
    },
    data?.upcomingCount ?? null,
  );
}

function Heading({ total }: { total: number | null }) {
  if (total == null) return <>Maisons aux enchères</>;
  if (total === 0) return <>Aucune maison aux enchères à venir pour le moment.</>;
  return (
    <>
      <HighlightedFigure>{count.format(total)}</HighlightedFigure>{" "}
      {total > 1 ? "maisons aux enchères à venir." : "maison aux enchères à venir."}
    </>
  );
}

export default async function Page() {
  const data = await loadSaleLandingForPage(PAGE.key);
  return (
    <SaleLandingView
      page={PAGE}
      data={data}
      eyebrow="Ventes aux enchères · Maisons"
      heading={<Heading total={data?.upcomingCount ?? null} />}
      intro="Les maisons mises en vente au tribunal, chez le notaire ou par l’État, et référencées par Immojudis."
      articleSlugs={[
        "acheter-bien-occupe-encheres",
        "lire-plu-bien-vendu-encheres",
        "risques-georisques-avant-encherir",
        "frais-vente-encheres-judiciaire",
      ]}
    >
      <SaleLandingSection id="acheter" title="Acheter une maison aux enchères : les étapes">
        <BuyingSteps />
      </SaleLandingSection>
      <SaleLandingSection id="verifier" title="Les points à vérifier pour une maison">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>L’occupation.</strong> Une maison peut être vendue occupée, par son propriétaire
            ou par un locataire. Le cahier des conditions de vente le précise : lisez-le avant
            d’enchérir.
          </li>
          <li>
            <strong>Le terrain et l’urbanisme.</strong> Surface de la parcelle, servitudes et règles
            du plan local d’urbanisme (PLU) si vous envisagez des travaux ou une extension.
          </li>
          <li>
            <strong>Les risques et l’état du bâti.</strong> État des risques naturels, diagnostics
            (dont le DPE) et travaux à prévoir : ils pèsent sur le budget autant que le prix.
          </li>
        </ul>
        <p>
          Vous cherchez plutôt un appartement ?{" "}
          <Link
            href={SALE_LANDING_PAGES.apartment.path}
            className="font-semibold text-gold-text underline"
          >
            Voir les appartements aux enchères
          </Link>
          .
        </p>
      </SaleLandingSection>
    </SaleLandingView>
  );
}
