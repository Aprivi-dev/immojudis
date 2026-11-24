import Link from "next/link";
import { ANALYSIS_TRIAL_DAYS } from "@/lib/analysis-offer";
import { ceilingTermWithArticleText } from "@/lib/fee-regime-labels";
import { isFeeRegimeOpen, type FeeRegimeKey } from "@/lib/fee-regime-open";
import { formatNumber, formatPrice } from "@/lib/format";
import type { HomeCatalogueSummary } from "@/lib/home-catalogue-summary.server";
import { computeAcquisitionCosts, DEFAULTS } from "@/lib/profitability";
import { notaryAndStatePilotsEnabled } from "@/lib/sale-types";
import { ArrowRight } from "./HomeIcons";
import styles from "./HomePage.module.css";

/** Prix d'adjudication du repère de frais du bandeau de chiffres et de la FAQ. */
export const HOME_FEES_EXAMPLE_PRICE = 150_000;

/**
 * Poids des frais en plus du prix (en %, arrondi à l'unité) pour un bien adjugé
 * `HOME_FEES_EXAMPLE_PRICE`, calculé par le moteur du simulateur de frais avec ses hypothèses par
 * défaut (`DEFAULT_HYPOTHESES` : département non précisé, frais préalables et honoraires d'exemple,
 * sans travaux). Une seule source pour le bandeau et la FAQ.
 */
export const HOME_FEES_EXAMPLE_PCT = Math.round(
  computeAcquisitionCosts({
    price: HOME_FEES_EXAMPLE_PRICE,
    fpt: DEFAULTS.fpt,
    lawyerFees: DEFAULTS.lawyerFees,
    works: 0,
    department: null,
  }).acquisitionFeesPct,
);

type Stat = { value: string; label: string; countTo?: number; href?: string };

/** Les chiffres réels du catalogue ; un chiffre inconnu n'est pas affiché (jamais de repli inventé). */
export function HomeStats({
  summary,
  departments,
}: {
  summary: HomeCatalogueSummary | null;
  departments: number | null;
}) {
  if (!summary && !departments) return null;
  const stats: Stat[] = [];
  if (summary) {
    stats.push({
      value: formatNumber(summary.count),
      countTo: summary.count,
      label: summary.count > 1 ? "ventes à venir en France" : "vente à venir en France",
    });
  }
  if (departments) {
    stats.push({
      value: formatNumber(departments),
      countTo: departments,
      label:
        departments > 1
          ? "départements où une vente est annoncée"
          : "département où une vente est annoncée",
      // Le chiffre mène à la liste des ventes par département (repasse design n° 32).
      href: "/ventes-encheres-immobilieres",
    });
  }
  if (notaryAndStatePilotsEnabled()) {
    stats.push({ value: "3", label: "lieux de vente réunis : tribunal, notaire, État" });
  }
  stats.push({
    value: `≈\u00a0${formatNumber(HOME_FEES_EXAMPLE_PCT)}\u00a0%`,
    label: `de frais en plus du prix, pour un bien adjugé ${formatPrice(HOME_FEES_EXAMPLE_PRICE)} au tribunal (hypothèses du simulateur)`,
    href: "/simulateur-frais-encheres",
  });
  return (
    <section className={styles.statsBand} aria-label="Le catalogue en chiffres">
      <div className={styles.container}>
        <dl className={styles.stats} data-reveal="">
          {stats.map((stat) => (
            <div key={stat.label} className={styles.stat}>
              <dt>
                {stat.href ? (
                  <Link href={stat.href} prefetch={false} className={styles.textLink}>
                    {stat.label}
                  </Link>
                ) : (
                  stat.label
                )}
              </dt>
              <dd data-count-to={stat.countTo} className={styles.statValue}>
                {stat.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

/**
 * Les deux questions sur l'essai gratuit, selon l'état de l'essai à l'inscription lu par le serveur :
 * ouvert (`true`), fermé (`false`, elles disparaissent : ni la FAQ visible ni les données structurées
 * n'annoncent un essai qui n'existe plus) ou non lu (`undefined`, réponses vraies dans les deux états).
 */
function trialFaqItems(
  trialOpen: boolean | undefined,
): Array<{ question: string; answer: string }> {
  if (trialOpen === false) return [];
  if (trialOpen === undefined) {
    return [
      {
        question: "Et après l’essai gratuit ?",
        answer:
          "Votre compte revient à l’offre Découverte. Rien n’est prélevé. L’offre Analyse est ensuite proposée sur abonnement ; son tarif figure sur la page Offres.",
      },
      {
        question: "Quand commence l’essai gratuit ?",
        answer: `Quand l’essai est ouvert à l’inscription, il commence à la confirmation de votre adresse email, dure ${ANALYSIS_TRIAL_DAYS} jours et n’est proposé qu’une fois par personne.`,
      },
    ];
  }
  return [
    {
      question: `Et après les ${ANALYSIS_TRIAL_DAYS} jours d’essai ?`,
      answer:
        "Votre compte revient à l’offre Découverte. Rien n’est prélevé. L’offre Analyse est ensuite proposée sur abonnement ; son tarif figure sur la page Offres.",
    },
    {
      question: "Quand commence l’essai ?",
      answer: `À la confirmation de votre adresse email. Il dure ${ANALYSIS_TRIAL_DAYS} jours et n’est proposé qu’une fois par personne.`,
    },
  ];
}

/**
 * Pages piliers et repère « Pépite » : un bloc de liens pour comprendre avant d'enchérir (maillage
 * interne du guide, du simulateur, des tribunaux, des départements, des ressources et de la
 * méthode), puis une ligne factuelle sur le repère. Aucun chiffre promotionnel : le nombre de
 * pépites varie et n'est pas affiché ici.
 */
const GUIDE_LINKS = [
  { href: "/ventes-immobilieres-judiciaires", label: "Le guide de la vente judiciaire" },
  { href: "/simulateur-frais-encheres", label: "Le simulateur de frais d’enchères" },
  { href: "/tribunaux", label: "Les tribunaux et leurs ventes" },
  { href: "/ventes-encheres-immobilieres", label: "Les ventes par département" },
  { href: "/ressources", label: "Les ressources et articles" },
  { href: "/methode-ecart-marche", label: "Comment est calculé l’écart avec le marché" },
] as const;

export function HomeGuides() {
  return (
    <section
      id="comprendre"
      className={`${styles.section} ${styles.sectionFlush}`}
      aria-labelledby="guides-title"
    >
      <div className={styles.container}>
        <div className={styles.head} data-reveal="">
          <p className={styles.eyebrow}>Pour comprendre avant d’enchérir</p>
          <h2 id="guides-title" className={styles.h2}>
            Les guides, les outils et les méthodes.
          </h2>
        </div>
        <ul className={styles.guideLinks} data-reveal="">
          {GUIDE_LINKS.map((link) => (
            <li key={link.href}>
              <Link href={link.href} className={styles.textLink}>
                {link.label} <ArrowRight aria-hidden size={16} />
              </Link>
            </li>
          ))}
        </ul>
        <div className={styles.pepite} data-reveal="">
          <p className={styles.pepiteLine}>
            Le repère « Pépite » signale les ventes qui remplissent deux conditions chiffrées et
            publiques. Il n’est ni un conseil, ni une prévision de prix, ni une garantie.
          </p>
          <p className={styles.sourceLinks}>
            <Link href="/methode-pepites" className={styles.textLink}>
              Comment il est calculé <ArrowRight aria-hidden size={16} />
            </Link>
            <Link href="/sales?pepite=true" prefetch={false} className={styles.textLink}>
              Voir les pépites <ArrowRight aria-hidden size={16} />
            </Link>
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * Questions fréquentes : affichées en accordéon et reprises en données structurées (FAQPage).
 * `trialOpen` : l'essai à l'inscription est ouvert, lu par la page serveur (`readLaunchOfferState`) ;
 * absent : état non lu. `openFeeRegimes` : régimes de frais ouverts au plafond.
 */
export function homeFaqItems({
  trialOpen,
  openFeeRegimes,
}: { trialOpen?: boolean; openFeeRegimes?: readonly FeeRegimeKey[] } = {}): Array<{
  question: string;
  answer: string;
  /** Guide qui détaille la réponse : lien affiché sous la réponse (hors balisage FAQPage). */
  guide?: { href: string; label: string };
}> {
  // Où le plafond existe : le tribunal toujours, les ventes notariales selon l'interrupteur par
  // régime (même source que les cartes d'offres). Les ventes domaniales n'en ont pas.
  const notaryOpen =
    isFeeRegimeOpen("notary_auction", openFeeRegimes) ||
    isFeeRegimeOpen("notary_online", openFeeRegimes);
  const onlineOpen = isFeeRegimeOpen("notary_online", openFeeRegimes);
  const ceilingScope = notaryOpen
    ? `Elle est proposée pour les ventes au tribunal et les ventes notariales${onlineOpen ? " ; pour une vente notariale par offres, on parle d’offre plafond" : ""}.`
    : "Elle est proposée pour les ventes au tribunal.";
  return [
    {
      question: "Combien coûte l’inscription ?",
      answer:
        "Rien. Aucune carte bancaire n’est demandée, et l’offre Découverte reste gratuite sans limite de durée.",
    },
    ...trialFaqItems(trialOpen),
    {
      question: "D’où viennent les ventes ?",
      answer: notaryAndStatePilotsEnabled()
        ? "Des annonces publiées pour les ventes des tribunaux judiciaires, des notaires et de l’État. La date de la dernière vérification des données est affichée en haut de cette page."
        : "Des annonces publiées pour les ventes des tribunaux judiciaires. La date de la dernière vérification des données est affichée en haut de cette page.",
    },
    {
      question: `Comment est calculée ${ceilingTermWithArticleText(openFeeRegimes)} ?`,
      answer: `Valeur estimée du bien, moins les frais de la vente, le budget travaux et votre marge de sécurité. Chaque hypothèse est modifiable. ${ceilingScope}`,
    },
    {
      question: "Qu’est-ce que la mise à prix ?",
      answer:
        "C’est le montant à partir duquel les enchères démarrent. Au tribunal, elle figure dans le cahier des conditions de vente, le document qui décrit le bien et les règles de la vente. Ce n’est pas le prix final : la vente peut se conclure au-dessus. Pour une vente notariale par offres, on parle de première offre possible.",
    },
    {
      question: "Quelle confiance accorder aux estimations ?",
      answer:
        "Elles sont indicatives : elles reposent sur les ventes voisines enregistrées dans DVF et s’affichent avec une fourchette. Lisez les pièces et visitez le bien avant d’enchérir.",
    },
    {
      question: "Comment enchérir à une vente au tribunal ?",
      answer:
        "Au tribunal judiciaire, les enchères sont portées par un avocat inscrit au barreau de ce tribunal. Immojudis vous aide à préparer la vente ; il ne porte pas d’enchères.",
    },
    {
      question: "Faut-il verser une garantie pour enchérir ?",
      answer:
        "Oui, pour une vente au tribunal. Avant l’audience, l’avocat qui porte vos enchères se fait remettre un chèque de banque ou une caution bancaire de 10 % de la mise à prix, avec un minimum de 3 000 € (art. R. 322-41 du Code des procédures civiles d’exécution). Elle est rendue à l’issue de l’audience à celui qui ne gagne pas.",
      guide: {
        href: "/ressources/garantie-10-pourcent-cheque-banque-caution-encheres",
        label: "Lire le guide de la garantie",
      },
    },
    {
      question: "Les frais s’ajoutent-ils au prix d’adjudication ?",
      answer: `Oui. Les frais de poursuite fixés par le juge et les droits de mutation sont payés en plus du prix (art. R. 322-58), et les émoluments et honoraires des avocats s’y ajoutent. Avec les hypothèses du simulateur Immojudis, le total représente environ ${formatNumber(HOME_FEES_EXAMPLE_PCT)}\u00a0% du prix pour un bien adjugé ${formatPrice(HOME_FEES_EXAMPLE_PRICE)}.`,
      guide: {
        href: "/ressources/frais-vente-encheres-judiciaire",
        label: "Lire le guide des frais",
      },
    },
    {
      question: "Y a-t-il une condition suspensive de prêt ?",
      answer:
        "En principe non, pour une vente au tribunal : la procédure ne prévoit pas de sortie en cas de refus de prêt. Le prix et les frais se paient dans les deux mois de l’adjudication définitive, sinon le bien est remis en vente. Le financement se prépare donc avant l’audience.",
      guide: {
        href: "/ressources/financer-achat-encheres-pret-delais",
        label: "Lire le guide du financement",
      },
    },
    {
      question: "Qu’est-ce que la surenchère du dixième ?",
      answer:
        "Pendant dix jours après l’adjudication au tribunal, toute personne peut faire une offre supérieure d’au moins un dixième du prix principal, par l’intermédiaire d’un avocat (art. R. 322-50 et R. 322-51). Si elle est valable, le bien est remis aux enchères : l’achat n’est donc définitif qu’à l’issue de ce délai.",
      guide: {
        href: "/ressources/apres-adjudication-surenchere-paiement-titre-vente",
        label: "Lire le guide après l’adjudication",
      },
    },
    {
      question: "Comment être prévenu des nouvelles ventes ?",
      answer:
        "Créez une alerte sur votre secteur : les nouvelles ventes qui y correspondent vous sont envoyées par email.",
    },
  ];
}

export function HomeFaq({
  trialOpen,
  openFeeRegimes,
}: { trialOpen?: boolean; openFeeRegimes?: readonly FeeRegimeKey[] } = {}) {
  return (
    <section
      id="questions"
      className={`${styles.section} ${styles.sectionFlush}`}
      aria-labelledby="faq-title"
    >
      <div className={`${styles.container} ${styles.faqGrid}`}>
        <div className={`${styles.head} ${styles.headAside}`} data-reveal="">
          <p className={styles.eyebrow}>Questions fréquentes</p>
          <h2 id="faq-title" className={styles.h2}>
            Avant de vous inscrire.
          </h2>
          <p className={styles.lead}>
            Une autre question ?{" "}
            <Link href="/contact" className={styles.textLink}>
              La page Contact
            </Link>{" "}
            est faite pour ça.
          </p>
        </div>
        <div className={styles.faq} data-reveal="">
          {homeFaqItems({ trialOpen, openFeeRegimes }).map((item) => (
            <details key={item.question}>
              <summary>
                {item.question}
                <span className={styles.plus} aria-hidden />
              </summary>
              <p className={styles.answer}>{item.answer}</p>
              {item.guide ? (
                <p className={styles.answer}>
                  <Link href={item.guide.href} className={styles.textLink}>
                    {item.guide.label} <ArrowRight aria-hidden size={16} />
                  </Link>
                </p>
              ) : null}
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
