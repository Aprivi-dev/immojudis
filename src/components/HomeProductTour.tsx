import Image from "next/image";
import Link from "next/link";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import { ProductTourTabs } from "./ProductTourTabs";
import styles from "./HomeProductTour.module.css";

/**
 * Captures d'écran du site (octobre 2026). La carte vient du catalogue public ; les trois autres
 * viennent de /annonce-exemple, dont le bien et les chiffres sont fictifs : le badge le dit.
 */
export const PRODUCT_TOUR_SCREENS = [
  {
    id: "carte",
    title: "La carte des ventes",
    description:
      "Repérez les ventes sur la carte, puis filtrez par secteur, mise à prix, date ou type de bien.",
    image: "/media/landing/apercu-carte.webp",
    alt: "Capture du catalogue : la liste des annonces à gauche, la carte de France des ventes à droite.",
    badge: "Capture du catalogue",
  },
  {
    id: "fiche",
    title: "La fiche et les pièces",
    description:
      "Chaque information est reliée à son origine (cahier des conditions de vente, procès-verbal descriptif, page par page) et ce qui manque est signalé, selon la vente.",
    image: "/media/landing/apercu-fiche.webp",
    alt: "Fiche d’un exemple fictif : les informations du bien, chacune avec le document et la page dont elle vient.",
    badge: "Exemple fictif",
  },
  {
    id: "estimation",
    title: "L’estimation et les comparables DVF",
    description:
      "Une fourchette de prix fondée sur les ventes du secteur (DVF) et la solidité de l’échantillon. Le détail des comparables est inclus dans Analyse.",
    image: "/media/landing/apercu-estimation.webp",
    alt: "Exemple fictif : mise à prix, enchère plafond et valeur estimée, puis la fourchette de marché DVF et le nombre de ventes comparables.",
    badge: "Exemple fictif",
  },
  {
    id: "plafond",
    title: "L’enchère plafond",
    description:
      "Le montant à ne pas dépasser à l’audience, une fois comptés la valeur du bien, votre marge, les travaux et les frais. Simulation, pour les ventes au tribunal.",
    image: "/media/landing/apercu-plafond.webp",
    alt: "Exemple fictif : le calcul de l’enchère plafond (simulation) selon le projet, avec les scénarios prudent, équilibré et offensif.",
    badge: "Exemple fictif",
  },
] as const;

const SCREEN_SIZES = "(max-width: 900px) 100vw, 58vw";

/**
 * Rendue sur le serveur : textes et images ne pèsent pas dans le JavaScript client. Seul le
 * passage d'un onglet à l'autre (ProductTourTabs) est envoyé au navigateur.
 */
export function HomeProductTour() {
  return (
    <section className={styles.tour} aria-labelledby="product-tour-title">
      <div className={styles.container}>
        <div className={styles.intro}>
          <p className={styles.eyebrow}>Sur Immojudis</p>
          <h2 id="product-tour-title">
            De l’annonce <em>à la décision.</em>
          </h2>
        </div>

        <ProductTourTabs
          label="Ce que vous voyez sur Immojudis"
          items={PRODUCT_TOUR_SCREENS.map((screen, index) => ({
            id: screen.id,
            tab: (
              <>
                <span className={styles.tabNumber} aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className={styles.tabText}>
                  <span id={`product-tour-title-${screen.id}`} className={styles.tabTitle}>
                    {screen.title}
                  </span>
                  <span className={styles.tabDescription}>{screen.description}</span>
                </span>
              </>
            ),
            panel: (
              <div className={styles.frame} data-screen={screen.id}>
                <Image src={screen.image} alt={screen.alt} fill sizes={SCREEN_SIZES} />
                <span className={styles.badge}>{screen.badge}</span>
              </div>
            ),
          }))}
          footer={
            <div className={styles.screensFooter}>
              <p>Les informations disponibles varient selon chaque vente.</p>
              <Link href="/annonce-exemple" prefetch={false} className={styles.link}>
                Voir une analyse exemple <ArrowRight aria-hidden="true" size={17} />
              </Link>
            </div>
          }
        />
      </div>
    </section>
  );
}
