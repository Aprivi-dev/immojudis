import Link from "next/link";
import type { CSSProperties } from "react";
import { ANALYSIS_TRIAL_DAYS } from "@/lib/analysis-offer";
import { exampleHeadlineFigures } from "@/lib/example-sale";
import { ceilingTermWithArticleText } from "@/lib/fee-regime-labels";
import { isFeeRegimeOpen, type FeeRegimeKey } from "@/lib/fee-regime-open";
import { formatNumber, formatPrice } from "@/lib/format";
import type { HomeCatalogueSummary } from "@/lib/home-catalogue-summary.server";
import { MONTHLY_SALE_UNLOCKS } from "@/lib/sale-unlocks";
import { notaryAndStatePilotsEnabled } from "@/lib/sale-types";
import { ArrowRight, Bank, Bell, ChartBar, FileText, MapPin, Target } from "./HomeIcons";
import {
  HomeBrowseWithoutAccount,
  HomePrimaryAction,
  HomeSignupStepText,
} from "./HomePrimaryAction";
import styles from "./HomePage.module.css";

// Mêmes chiffres que /annonce-exemple : calculés une fois depuis l'exemple, jamais saisis ici.
const EXAMPLE = exampleHeadlineFigures();

function delay(ms: number): CSSProperties {
  return { "--delay": `${ms}ms` } as CSSProperties;
}

type Stat = { value: string; label: string; countTo?: number };

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
    });
  }
  if (notaryAndStatePilotsEnabled()) {
    stats.push({ value: "3", label: "lieux de vente réunis : tribunal, notaire, État" });
  }
  stats.push({
    value: formatNumber(MONTHLY_SALE_UNLOCKS),
    label: "fiches détaillées gratuites chaque mois",
  });
  return (
    <section className={styles.statsBand} aria-label="Le catalogue en chiffres">
      <div className={styles.container}>
        <dl className={styles.stats} data-reveal="">
          {stats.map((stat) => (
            <div key={stat.label} className={styles.stat}>
              <dt>{stat.label}</dt>
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

/** Quatre bénéfices, chacun avec sa petite illustration. */
export function HomeBenefits() {
  const share = (value: number) => `${((value / EXAMPLE.marketValue) * 100).toFixed(1)}%`;
  return (
    <section
      id="avantages"
      className={`${styles.section} ${styles.sectionFlush}`}
      aria-labelledby="benefits-title"
    >
      <div className={styles.container}>
        <div className={styles.head} data-reveal="">
          <p className={styles.eyebrow}>Ce que vous savez avant d’enchérir</p>
          <h2 id="benefits-title" className={styles.h2}>
            Quatre réponses que l’annonce ne donne pas.
          </h2>
        </div>
        <div className={styles.benefits}>
          <article className={styles.benefit} data-reveal="">
            <span className={styles.icon} aria-hidden>
              <FileText size={22} />
            </span>
            <h3>Sachez ce que disent les pièces</h3>
            <p>
              Cahier des conditions de vente, descriptif du bien, diagnostics : les points clés
              relevés pièce par pièce, selon la vente.
            </p>
            <span className={`${styles.visual} ${styles.docLines}`} aria-hidden>
              {[92, 74, 86, 58, 80].map((width, index) => (
                <i
                  key={index}
                  className={index % 2 ? styles.highlight : undefined}
                  style={{ width: `${width}%` }}
                />
              ))}
            </span>
          </article>
          <article className={styles.benefit} data-reveal="" style={delay(120)}>
            <span className={styles.icon} aria-hidden>
              <Target size={22} />
            </span>
            <h3>Connaissez votre enchère plafond</h3>
            <p>
              Valeur estimée, frais de la vente, travaux et marge de sécurité : le montant à ne pas
              dépasser, que vous ajustez à votre projet.
            </p>
            <span className={styles.visual} aria-hidden>
              <span className={`${styles.bar} ${styles.barSmall}`}>
                <i className={styles.barCeiling} style={{ width: share(EXAMPLE.ceiling) }} />
                <i className={styles.barCosts} style={{ width: share(EXAMPLE.feesAndWorks) }} />
                <i className={styles.barMargin} style={{ width: share(EXAMPLE.safetyMargin) }} />
              </span>
              <span className={styles.visualLegend}>
                <span>Plafond {formatPrice(EXAMPLE.ceiling)}</span>
                <span>Valeur {formatPrice(EXAMPLE.marketValue)}</span>
              </span>
            </span>
          </article>
          <article className={styles.benefit} data-reveal="" style={delay(60)}>
            <span className={styles.icon} aria-hidden>
              <ChartBar size={22} />
            </span>
            <h3>Situez la mise à prix face au quartier</h3>
            <p>
              Le prix au mètre carré des ventes voisines enregistrées dans les Demandes de valeurs
              foncières (DVF), comparé à la vente.
            </p>
            <span className={styles.visual} aria-hidden>
              <span className={styles.miniBars}>
                {[52, 70, 30, 84, 62, 76].map((height, index) => (
                  <i
                    key={index}
                    className={index === 2 ? styles.mine : undefined}
                    style={{ height: `${height}%` }}
                  />
                ))}
              </span>
              <span className={styles.visualLegend}>
                <span>Ventes voisines (illustration)</span>
                <span>Mise à prix</span>
              </span>
            </span>
          </article>
          <article className={styles.benefit} data-reveal="" style={delay(180)}>
            <span className={styles.icon} aria-hidden>
              <Bell size={22} />
            </span>
            <h3>Suivez les nouvelles ventes de votre secteur</h3>
            <p>
              Une alerte sur votre zone : les nouvelles ventes que nous collectons et les dates
              d’audience confirmées vous sont envoyées par email.
            </p>
            <span className={styles.visual} aria-hidden>
              <span className={styles.toast}>
                <i />
                Nouvelle vente dans votre secteur
              </span>
              <span className={styles.toast}>
                <i />
                Date d’audience confirmée
              </span>
            </span>
          </article>
        </div>
      </div>
    </section>
  );
}

/** De l'inscription à l'audience, en trois étapes (une vraie séquence : numérotée). */
export function HomeSteps() {
  return (
    <section
      id="etapes"
      className={`${styles.section} ${styles.stepsBand}`}
      aria-labelledby="steps-title"
    >
      <div className={styles.container}>
        <div className={styles.head} data-reveal="">
          <p className={styles.eyebrow}>Comment ça marche</p>
          <h2 id="steps-title" className={styles.h2}>
            De l’annonce à l’audience, en trois étapes.
          </h2>
        </div>
        <ol className={styles.steps}>
          <li className={styles.step} data-reveal="">
            <span className={styles.stepNumber}>Étape 1</span>
            <h3>Créez votre compte gratuit</h3>
            <HomeSignupStepText />
          </li>
          <li className={styles.step} data-reveal="" style={delay(120)}>
            <span className={styles.stepNumber}>Étape 2</span>
            <h3>Repérez vos ventes</h3>
            <p>
              Cherchez par ville, département ou région, puis enregistrez une alerte sur votre
              secteur.
            </p>
          </li>
          <li className={styles.step} data-reveal="" style={delay(240)}>
            <span className={styles.stepNumber}>Étape 3</span>
            <h3>Fixez votre plafond</h3>
            <p>
              Lisez les points clés des pièces, ajustez travaux et marge, puis confiez votre limite
              à votre avocat.
            </p>
          </li>
        </ol>
      </div>
    </section>
  );
}

/** D'où viennent les chiffres : les sources publiques et la méthode. */
export function HomeSources() {
  return (
    <section className={styles.section} aria-labelledby="sources-title">
      <div className={`${styles.container} ${styles.split}`}>
        <div className={`${styles.head} ${styles.headAside}`} data-reveal="">
          <p className={styles.eyebrow}>D’où viennent les chiffres</p>
          <h2 id="sources-title" className={styles.h2}>
            Des sources publiques, une méthode publiée.
          </h2>
          <p className={styles.lead}>
            Chaque estimation affiche sa fourchette et les ventes qui la fondent. Quand les données
            manquent, la fiche le dit.
          </p>
          <p className={styles.sourceLinks}>
            <Link href="/annonce-exemple" prefetch={false} className={styles.textLink}>
              Voir une analyse exemple <ArrowRight aria-hidden size={16} />
            </Link>
            <Link href="/methode-ecart-marche" className={styles.textLink}>
              La méthode <ArrowRight aria-hidden size={16} />
            </Link>
          </p>
        </div>
        <ul className={styles.sources} data-reveal="">
          <li>
            <Bank aria-hidden size={20} />
            <div>
              <b>Annonces et pièces des ventes</b>
              <span>
                {notaryAndStatePilotsEnabled()
                  ? "Publiées pour chaque vente par les avocats poursuivants, les notaires et les services de l’État."
                  : "Publiées pour chaque vente par les avocats poursuivants."}
              </span>
            </div>
          </li>
          <li>
            <ChartBar aria-hidden size={20} />
            <div>
              <b>Demandes de valeurs foncières (DVF)</b>
              <span>
                Les ventes immobilières enregistrées, publiées par la Direction générale des
                finances publiques.
              </span>
            </div>
          </li>
          <li>
            <MapPin aria-hidden size={20} />
            <div>
              <b>Géoplateforme de l’IGN</b>
              <span>
                La position de chaque adresse, pour placer la vente au bon endroit sur la carte.
              </span>
            </div>
          </li>
        </ul>
      </div>
    </section>
  );
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
        <p className={styles.pepiteLine} data-reveal="">
          Le repère « Pépite » signale les ventes qui remplissent deux conditions chiffrées et
          publiques. Il n’est ni un conseil, ni une prévision de prix, ni une garantie.{" "}
          <Link href="/methode-pepites" className={styles.textLink}>
            Comment il est calculé
          </Link>{" "}
          ·{" "}
          <Link href="/sales?pepite=true" prefetch={false} className={styles.textLink}>
            Voir les pépites
          </Link>
        </p>
      </div>
    </section>
  );
}

/** Questions fréquentes : affichées en accordéon et reprises en données structurées (FAQPage). */
export function homeFaqItems(
  openFeeRegimes?: readonly FeeRegimeKey[],
): Array<{ question: string; answer: string }> {
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
    {
      question: `Et après les ${ANALYSIS_TRIAL_DAYS} jours d’essai ?`,
      answer:
        "Votre compte revient à l’offre Découverte. Rien n’est prélevé. L’offre Analyse est ensuite proposée sur abonnement ; son tarif figure sur la page Offres.",
    },
    {
      question: "Quand commence l’essai ?",
      answer: `À la confirmation de votre adresse email. Il dure ${ANALYSIS_TRIAL_DAYS} jours et n’est proposé qu’une fois par personne.`,
    },
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
      question: "Comment être prévenu des nouvelles ventes ?",
      answer:
        "Créez une alerte sur votre secteur : les nouvelles ventes qui y correspondent vous sont envoyées par email.",
    },
  ];
}

export function HomeFaq({ openFeeRegimes }: { openFeeRegimes?: readonly FeeRegimeKey[] } = {}) {
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
          {homeFaqItems(openFeeRegimes).map((item) => (
            <details key={item.question}>
              <summary>
                {item.question}
                <span className={styles.plus} aria-hidden />
              </summary>
              <p className={styles.answer}>{item.answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

/** Dernier écran, sur fond sombre : la même action principale qu'en haut de page. */
export function HomeClosing({
  summary,
  departments,
}: {
  summary: HomeCatalogueSummary | null;
  departments: number | null;
}) {
  return (
    <section className={styles.closing} aria-labelledby="closing-title">
      <div className={`${styles.container} ${styles.closingInner}`} data-reveal="">
        <h2 id="closing-title">Regardez ce qui se vend dans votre secteur.</h2>
        {summary ? (
          <p>
            {formatNumber(summary.count)} vente{summary.count > 1 ? "s" : ""} à venir
            {departments
              ? ` dans ${formatNumber(departments)} département${departments > 1 ? "s" : ""}`
              : ""}
            , sur une seule carte.
          </p>
        ) : null}
        <HomePrimaryAction />
        <HomeBrowseWithoutAccount className={styles.textLink} />
      </div>
    </section>
  );
}
