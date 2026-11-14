import Link from "next/link";
import { EXISTING_GUIDE } from "@/lib/resource-articles";

const TEXT_LINK = "font-semibold text-gold-text underline";

/**
 * Les étapes d'un achat aux enchères, communes aux pages « maison » et « appartement ». Chaque fait
 * juridique reprend le guide des ventes judiciaires (`resources-guide.tsx`, articles du CPCE cités)
 * et l'article sur les ventes notariales et domaniales : une correction là-bas se reporte ici.
 */
export function BuyingSteps() {
  return (
    <>
      <p>
        La démarche dépend de l’organisateur de la vente, indiqué sur chaque fiche. Au tribunal et à
        la bougie chez le notaire, ce sont des enchères qui se terminent par une adjudication. Une
        vente notariale interactive se fait par offres en ligne, et l’État vend par adjudication,
        appel d’offres ou vente amiable.
      </p>
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          <strong>Lire les pièces.</strong> Au tribunal, le cahier des conditions de vente décrit le
          bien, son occupation, les diagnostics et les frais ; chez le notaire ou pour l’État, c’est
          le cahier des charges. C’est lui qui fixe les règles de la vente.
        </li>
        <li>
          <strong>Visiter.</strong> Les visites, quand elles sont prévues, ont lieu aux dates
          indiquées dans l’annonce.
        </li>
        <li>
          <strong>Préparer le budget.</strong> Au tribunal, les frais de poursuite, les droits de
          mutation, les émoluments et les honoraires de l’avocat s’ajoutent au prix d’adjudication ;
          chez le notaire, demandez si les frais sont compris dans le prix annoncé. Le{" "}
          <Link href="/simulateur-frais-encheres" className={TEXT_LINK}>
            simulateur de frais
          </Link>{" "}
          en donne un ordre de grandeur.
        </li>
        <li>
          <strong>Enchérir.</strong> Au tribunal, les enchères sont portées par un avocat inscrit au
          barreau du tribunal compétent, après remise d’une garantie de {"10\u00a0%"} de la mise à
          prix ({"3\u202f000\u00a0€"} au minimum en saisie immobilière). Chez le notaire et pour
          l’État, les conditions de participation sont celles du cahier des charges.
        </li>
        <li>
          <strong>Après la vente.</strong> En saisie immobilière, toute personne peut former une
          surenchère d’au moins un dixième du prix dans les dix jours qui suivent l’adjudication ;
          le prix est ensuite à verser dans les deux mois de l’adjudication définitive.
        </li>
      </ol>
      <p>
        Chaque étape est détaillée dans{" "}
        <Link href={EXISTING_GUIDE.href} className={TEXT_LINK}>
          le guide des ventes immobilières judiciaires
        </Link>{" "}
        ; les autres questions ont leur article dans{" "}
        <Link href="/ressources" className={TEXT_LINK}>
          les ressources
        </Link>
        .
      </p>
    </>
  );
}
