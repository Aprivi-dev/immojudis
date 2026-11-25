import Link from "next/link";
import type { CSSProperties } from "react";
import { formatNumber } from "@/lib/format";
import type { HomeCatalogueSummary } from "@/lib/home-catalogue-summary.server";
import { ArrowRight } from "./HomeIcons";
import { HomePainting, homePaintingUrl, type HomePaintingName } from "./HomePainting";
import { HomeBrowseWithoutAccount, HomePrimaryAction } from "./HomePrimaryAction";
import styles from "./HomePage.module.css";
import scenes from "./HomeScenes.module.css";

/*
 * Les sections peintes de l'accueil (refonte du 24/11/2026). Tout est lisible sans script : les
 * scènes épinglées, les entrées et les boucles vidéo sont ajoutées par `HomeScrollScenes`, qui lit
 * les attributs `data-home-*` posés ici.
 */

/** Ce qu'une fiche peut réunir. `x`, `y` : place dans la scène (en %) ; `d` : départ dans la scène. */
/**
 * Écran étroit : les éléments de la scène du dossier s'accrochent au bord le plus proche (une
 * étiquette placée à 84 % de la gauche sortirait de l'écran) et s'écartent du centre, où se lit la
 * phrase.
 */
function narrowPlace(x: number, y: number): Record<string, string> {
  const side: Record<string, string> =
    x < 50
      ? { "--mx": `${Math.round(x * 0.5 + 2)}%` }
      : { "--mr": `${Math.round((100 - x) * 0.5 + 2)}%` };
  return { ...side, "--my": `${Math.round(y < 50 ? 9 + y * 0.52 : 100 - (100 - y) * 0.6 - 8)}%` };
}

const DOSSIER_ITEMS: ReadonlyArray<{ label: string; x: number; y: number; d: number }> = [
  { label: "Cahier des conditions de vente", x: 4, y: 14, d: 0 },
  { label: "Procès-verbal descriptif", x: 70, y: 9, d: 0.05 },
  { label: "Diagnostics", x: 22, y: 30, d: 0.1 },
  { label: "Occupation", x: 80, y: 36, d: 0.15 },
  { label: "Date d’audience", x: 6, y: 52, d: 0.2 },
  { label: "Tribunal", x: 74, y: 58, d: 0.25 },
  { label: "Ventes voisines (DVF)", x: 30, y: 12, d: 0.3 },
  { label: "Prix au mètre carré", x: 58, y: 22, d: 0.35 },
  { label: "Cadastre", x: 16, y: 72, d: 0.4 },
  { label: "Urbanisme", x: 66, y: 76, d: 0.45 },
  { label: "Mise à prix", x: 40, y: 86, d: 0.5 },
  { label: "Frais de la vente", x: 84, y: 18, d: 0.55 },
  { label: "Historique de l’annonce", x: 3, y: 34, d: 0.12 },
];

/** Recadrages des peintures qui traversent la scène. `w` : largeur (px sur grand écran). */
const DOSSIER_CROPS: ReadonlyArray<{
  painting: HomePaintingName;
  position: string;
  size: string;
  ratio: string;
  x: number;
  y: number;
  w: number;
  d: number;
}> = [
  {
    painting: "01-hero",
    position: "72% 22%",
    size: "330%",
    ratio: "4 / 5",
    x: 10,
    y: 58,
    w: 170,
    d: 0,
  },
  {
    painting: "02-pieces",
    position: "60% 62%",
    size: "260%",
    ratio: "1",
    x: 76,
    y: 64,
    w: 150,
    d: 0.08,
  },
  {
    painting: "07-audience",
    position: "50% 40%",
    size: "230%",
    ratio: "4 / 5",
    x: 44,
    y: 70,
    w: 120,
    d: 0.16,
  },
  {
    painting: "06-bougies",
    position: "56% 80%",
    size: "260%",
    ratio: "5 / 4",
    x: 60,
    y: 30,
    w: 96,
    d: 0.24,
  },
  {
    painting: "03-quartier",
    position: "72% 58%",
    size: "250%",
    ratio: "1",
    x: 24,
    y: 8,
    w: 120,
    d: 0.32,
  },
  {
    painting: "09-frise",
    position: "48% 70%",
    size: "520%",
    ratio: "4 / 5",
    x: 88,
    y: 44,
    w: 110,
    d: 0.2,
  },
  {
    painting: "04-plafond",
    position: "78% 55%",
    size: "230%",
    ratio: "5 / 4",
    x: 34,
    y: 40,
    w: 84,
    d: 0.4,
  },
  {
    painting: "05-alertes",
    position: "62% 30%",
    size: "250%",
    ratio: "4 / 5",
    x: 14,
    y: 24,
    w: 104,
    d: 0.5,
  },
  {
    painting: "08-cle",
    position: "86% 42%",
    size: "300%",
    ratio: "1",
    x: 70,
    y: 84,
    w: 90,
    d: 0.58,
  },
];

/**
 * La scène du dossier : trois phrases au centre, et autour ce qu'une fiche peut réunir. Avec le
 * script, la page s'arrête et les éléments arrivent de derrière l'écran ; sans lui, tout est posé.
 */
export function HomeDossier() {
  return (
    <section className={scenes.dossier} aria-labelledby="dossier-title" data-home-scene="dossier">
      <div className={scenes.dossierPin}>
        <h2 id="dossier-title" className={scenes.dossierTitle}>
          <span data-home-line="">Chaque vente a son dossier.</span>{" "}
          <span data-home-line="">Nous le lisons, pièce par pièce.</span>{" "}
          <span data-home-line="">Vous arrivez avec une limite.</span>
        </h2>
        <div className={scenes.cloud}>
          <ul aria-label="Ce qu’une fiche peut réunir, selon ce qui est publié pour la vente">
            {DOSSIER_ITEMS.map((item) => (
              <li
                key={item.label}
                data-home-flier={item.d}
                style={
                  {
                    "--x": `${item.x}%`,
                    "--y": `${item.y}%`,
                    ...narrowPlace(item.x, item.y),
                  } as CSSProperties
                }
              >
                {item.label}
              </li>
            ))}
          </ul>
          {DOSSIER_CROPS.map((crop) => (
            <span
              key={`${crop.painting}-${crop.x}`}
              className={scenes.crop}
              aria-hidden
              data-home-flier={crop.d}
              style={
                {
                  "--x": `${crop.x}%`,
                  "--y": `${crop.y}%`,
                  ...narrowPlace(crop.x, crop.y),
                  "--w": String(crop.w),
                  aspectRatio: crop.ratio,
                  backgroundImage: `url(${homePaintingUrl(crop.painting)})`,
                  backgroundPosition: crop.position,
                  backgroundSize: crop.size,
                } as CSSProperties
              }
            />
          ))}
        </div>
      </div>
    </section>
  );
}

const ANSWERS: ReadonlyArray<{
  painting: HomePaintingName;
  eyebrow: string;
  title: string;
  text: string;
  href: string;
  link: string;
  /** Décalage d'entrée (px) : les quatre cartes convergent vers la grille. */
  from: readonly [number, number];
}> = [
  {
    painting: "02-pieces",
    eyebrow: "Les pièces",
    title: "Ce que dit le dossier",
    text: "Cahier des conditions de vente, descriptif du bien, diagnostics : les points clés relevés pièce par pièce, selon la vente.",
    href: "/annonce-exemple",
    link: "Voir une analyse exemple",
    from: [-120, -90],
  },
  {
    painting: "03-quartier",
    eyebrow: "Le quartier",
    title: "Ce que valent les voisins",
    text: "Le prix au mètre carré des ventes voisines enregistrées dans les Demandes de valeurs foncières (DVF), comparé à la vente.",
    href: "/methode-ecart-marche",
    link: "Lire la méthode",
    from: [120, -90],
  },
  {
    painting: "04-plafond",
    eyebrow: "Le plafond",
    title: "Jusqu’où monter",
    text: "Valeur estimée, frais de la vente, travaux et marge de sécurité : le montant à ne pas dépasser, que vous ajustez à votre projet.",
    href: "/simulateur-frais-encheres",
    link: "Simuler les frais",
    from: [-80, 70],
  },
  {
    painting: "05-alertes",
    eyebrow: "Les alertes",
    title: "Quand une vente arrive",
    text: "Une alerte sur votre zone : les nouvelles ventes que nous collectons et les dates d’audience confirmées vous sont envoyées par email.",
    href: "/sales",
    link: "Chercher dans mon secteur",
    from: [80, 70],
  },
];

/** Quatre réponses, une peinture chacune ; au survol, le texte prend la place de la peinture. */
export function HomeAnswers() {
  return (
    <section id="avantages" className={scenes.answers} aria-labelledby="answers-title">
      <div className={styles.container}>
        <div className={styles.head}>
          <p className={styles.eyebrow}>Ce que vous savez avant d’enchérir</p>
          <h2 id="answers-title" className={styles.h2}>
            Quatre réponses que l’annonce ne donne pas.
          </h2>
        </div>
        <div className={scenes.cards}>
          {ANSWERS.map((answer) => (
            <article
              key={answer.title}
              className={scenes.card}
              data-home-fx="gather"
              data-home-from={answer.from.join(",")}
            >
              <HomePainting
                name={answer.painting}
                alt=""
                sizes="(max-width: 620px) 100vw, 50vw"
                className={scenes.cardPainting}
              />
              <p className={scenes.cardEyebrow}>{answer.eyebrow}</p>
              <div className={scenes.cardBody}>
                <h3>{answer.title}</h3>
                <div className={scenes.cardMore}>
                  <div>
                    <p>{answer.text}</p>
                    <Link href={answer.href} prefetch={false} className={styles.textLink}>
                      {answer.link} <ArrowRight aria-hidden size={16} />
                    </Link>
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

const PATH_STEPS: ReadonlyArray<{ title: string; text: string; place: string; from: number }> = [
  {
    title: "Repérez",
    text: "Cherchez par ville, département ou région, sur la carte ou en liste.",
    place: scenes.tileA,
    from: 200,
  },
  {
    title: "Lisez",
    text: "Parcourez les points clés des pièces, puis visitez le bien.",
    place: scenes.tileB,
    from: -200,
  },
  {
    title: "Chiffrez",
    text: "Ajustez travaux et marge de sécurité : votre plafond se recalcule.",
    place: scenes.tileC,
    from: -200,
  },
  {
    title: "Mandatez",
    text: "Au tribunal, un avocat inscrit au barreau porte vos enchères. Confiez-lui votre limite.",
    place: scenes.tileD,
    from: 200,
  },
];

/** De l'annonce à l'audience : quatre gestes dans l'ordre, posés sur la peinture des trois bougies. */
export function HomePath() {
  return (
    <section id="etapes" className={scenes.path} aria-labelledby="path-title">
      <HomePainting name="06-bougies" alt="" sizes="100vw" className={scenes.pathPainting} />
      <div
        className={`${scenes.tile} ${scenes.tileLead}`}
        data-home-fx="gather"
        data-home-from="-200,0"
      >
        <h2 id="path-title" className={styles.h2}>
          De l’annonce à l’audience.
        </h2>
        <p>Quatre gestes, dans l’ordre, pour arriver à la vente avec une limite écrite.</p>
      </div>
      <ol className={scenes.pathSteps}>
        {PATH_STEPS.map((step) => (
          <li
            key={step.title}
            className={`${scenes.tile} ${step.place}`}
            data-home-fx="gather"
            data-home-from={`${step.from},0`}
          >
            <h3>{step.title}</h3>
            <p>{step.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Les règles d'une vente au tribunal, telles que la FAQ de la page les détaille (mêmes articles). */
const RULES: ReadonlyArray<{ value: string; label: string; note: string }> = [
  {
    value: "10 %",
    label: "de la mise à prix, remis en garantie à votre avocat avant l’audience",
    note: "3 000 € au minimum · art. R. 322-41",
  },
  {
    value: "10 jours",
    label: "pendant lesquels une surenchère du dixième peut rouvrir la vente",
    note: "art. R. 322-50 et R. 322-51",
  },
  {
    value: "2 mois",
    label: "pour payer le prix et les frais après l’adjudication définitive",
    note: "sinon le bien est remis en vente",
  },
  {
    value: "0",
    label: "condition suspensive de prêt, en principe",
    note: "le financement se prépare avant l’audience",
  },
  {
    value: "1 avocat",
    label: "inscrit au barreau du tribunal, pour porter vos enchères",
    note: "Immojudis ne porte pas d’enchères",
  },
];

/** Les règles du tribunal en cinq repères, à côté de la peinture de la salle d'audience. */
export function HomeRules() {
  return (
    <section id="regles" className={scenes.rules} aria-labelledby="rules-title">
      <div className={styles.container}>
        <div className={scenes.rulesTop}>
          <h2 id="rules-title" className={scenes.giant}>
            {["Les règles", "du tribunal", "ne se négocient", "pas."].map((line) => (
              <span key={line} data-home-fx="rise">
                <span>{line}</span>{" "}
              </span>
            ))}
          </h2>
          <div data-home-fx="pop">
            <HomePainting
              name="07-audience"
              alt="Peinture : des avocats en robe et des personnages de la Renaissance regardent le téléphone que tient une femme au centre."
              sizes="(max-width: 960px) 100vw, 45vw"
              className={scenes.rulesPainting}
            />
          </div>
        </div>
        <dl className={scenes.facts}>
          {RULES.map((rule) => (
            <div key={rule.value} className={scenes.fact} data-home-fx="pop">
              <dt>
                {rule.label}
                <small>{rule.note}</small>
              </dt>
              <dd>{rule.value}</dd>
            </div>
          ))}
          <div className={`${scenes.fact} ${scenes.factGuide}`} data-home-fx="pop">
            <dt>Préparez la vente avant d’entrer dans la salle.</dt>
            <dd>
              <Link href="/ventes-immobilieres-judiciaires" className={styles.textLink}>
                Lire le guide <ArrowRight aria-hidden size={16} />
              </Link>
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

/**
 * Dernier écran : la même action principale qu'ailleurs, sur la peinture de la clé. Avec le script,
 * la peinture entre petite puis grandit jusqu'à remplir l'écran pendant que la phrase laisse la
 * place à l'action.
 */
export function HomeClosing({
  summary,
  departments,
}: {
  summary: HomeCatalogueSummary | null;
  departments: number | null;
}) {
  return (
    <section className={scenes.closing} aria-labelledby="closing-title" data-home-scene="closing">
      <div className={scenes.closingPin}>
        <div className={scenes.grow} data-home-grow="">
          <HomePainting name="08-cle" alt="" sizes="100vw" className={scenes.growPainting} />
          <div className={scenes.growText}>
            <h2 id="closing-title" data-home-grow-one="">
              La salle d’audience n’est pas l’endroit où réfléchir.
            </h2>
            <div className={scenes.growAction} data-home-grow-two="">
              <p className={scenes.growLead}>Commencez par la carte.</p>
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
          </div>
        </div>
      </div>
    </section>
  );
}

/** La frise qui ferme la page : chacun travaille sur son écran. */
export function HomeFrieze() {
  return (
    <div className={scenes.frieze}>
      <HomePainting
        name="09-frise"
        alt="Peinture : une rangée d’avocats en robe et de personnages de la Renaissance, les yeux baissés sur leurs ordinateurs portables."
        sizes="100vw"
        className={scenes.friezePainting}
      />
    </div>
  );
}
