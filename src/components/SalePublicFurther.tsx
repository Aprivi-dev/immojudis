import Link from "next/link";
import styles from "./SalePublicPreview.module.css";

/**
 * Internal links of the public page: they carry the visitor from one sale to the pages that
 * explain how a sale works, and give crawlers a path from every sale to the guides.
 */
const FURTHER_READING_LINKS = [
  {
    href: "/ventes-immobilieres-judiciaires",
    label: "Le guide des ventes immobilières judiciaires",
    hint: "Comprendre le déroulement d’une vente",
  },
  {
    href: "/ressources/frais-vente-encheres-judiciaire",
    label: "Les frais d’une vente aux enchères",
    hint: "Ce qui s’ajoute au prix d’adjudication",
  },
  {
    href: "/tribunaux",
    label: "Les tribunaux",
    hint: "L’activité des tribunaux qui organisent des ventes",
  },
  {
    href: "/simulateur-frais-encheres",
    label: "Le simulateur de frais",
    hint: "Estimer les frais d’une enchère",
  },
] as const;

/** Bas de la fiche publique : les guides, puis la suite de la recherche. Chargé à part, rendu par le serveur. */
export function SalePublicFurther({ returnTo }: { returnTo: string }) {
  return (
    <>
      <section className={styles.further} aria-labelledby="public-further-title">
        <h2 id="public-further-title" className={styles.furtherTitle}>
          Pour aller plus loin
        </h2>
        <ul className={styles.furtherList}>
          {FURTHER_READING_LINKS.map((link) => (
            <li key={link.href}>
              <Link href={link.href}>{link.label}</Link>
              <span>{link.hint}</span>
            </li>
          ))}
        </ul>
      </section>
      <Link href={returnTo} className={`${styles.secondary} ${styles.continue}`}>
        Continuer ma recherche
      </Link>
    </>
  );
}
