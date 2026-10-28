"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  bidVerdict,
  bidVerdictSentence,
  BID_VERDICT_LABEL,
  TIGHT_MARGIN_LABEL,
} from "@/lib/bid-verdict";
import {
  EXAMPLE_OCCUPATIONS,
  EXAMPLE_PROJECTS,
  EXAMPLE_WORKS,
  findExampleScenario,
  type ExampleOccupation,
  type ExampleProject,
  type ExampleVerdictData,
  type ExampleWorks,
} from "@/lib/example-verdict-shared";
import { formatNumber, formatPrice } from "@/lib/format";
import { trackProductEvent } from "@/lib/product-events";
import { ArrowRight, Check } from "./HomeIcons";
import {
  OCCUPATION_LABEL,
  PROJECT_LABEL,
  scenarioExplanation,
  WORKS_LABEL,
} from "./example-verdict-text";
import { useCountTo } from "./use-count-to";
import { useDemoLoop } from "./use-demo-loop";
import styles from "./HomePage.module.css";

type Choice = { project: ExampleProject; occupation: ExampleOccupation; works: ExampleWorks };

/** Situation affichée d'abord : celle de /annonce-exemple (occupation à confirmer). */
const DEFAULT_CHOICE: Choice = {
  project: "habiter",
  occupation: "occupe",
  works: "rafraichissement",
};

/** Démonstration tant que le visiteur n'a rien choisi : du vert au rouge. */
const DEMO: Choice[] = [
  DEFAULT_CHOICE,
  { project: "habiter", occupation: "libre", works: "rafraichissement" },
  { project: "revendre", occupation: "loue", works: "rafraichissement" },
  { project: "louer", occupation: "occupe", works: "confort" },
];
const DEMO_MS = 3_000;
const DEMO_FIRST_MS = 2_200;

function Segmented<T extends string>({
  label,
  options,
  labels,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className={styles.tryControl}>
      <span id={`try-${label}`}>{label}</span>
      <div className={styles.segmented} role="group" aria-labelledby={`try-${label}`}>
        {options.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={option === value}
            onClick={() => onChange(option)}
          >
            {labels[option]}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * « Essayez sur un exemple » : les données qu'Immojudis croise pour l'annonce exemple, trois
 * réglages (projet, occupation, travaux) et le verdict, recalculé par le moteur d'enchère plafond
 * (tous les scénarios sont calculés au rendu serveur). Une démonstration défile une fois quand la
 * section apparaît ; elle s'arrête au survol, au focus, au toucher, au premier choix du visiteur et
 * sur le bouton « Mettre en pause l'animation ».
 */
export function HomeTryExample({ data }: { data: ExampleVerdictData }) {
  const [userChoice, setUserChoice] = useState<Choice | null>(null);
  const [visible, setVisible] = useState(false);
  const loop = useDemoLoop({
    steps: DEMO.length,
    firstMs: DEMO_FIRST_MS,
    stepMs: DEMO_MS,
    active: visible,
  });
  const choice = userChoice ?? DEMO[loop.step];
  const touched = userChoice !== null;

  // La démonstration démarre quand la carte est à l'écran.
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = card.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        setVisible(true);
      },
      { threshold: 0.3 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const choose = (patch: Partial<Choice>) => {
    if (!touched) trackProductEvent("home_example_used");
    loop.stop();
    setUserChoice({ ...choice, ...patch });
  };

  const scenario =
    findExampleScenario(data.scenarios, choice.project, choice.occupation, choice.works) ??
    data.scenarios[0];
  const ceiling = scenario?.ceiling ?? 0;
  const verdict = bidVerdict(ceiling, data.startingPrice);
  const shown = useCountTo(ceiling);
  const scale = data.valueHigh || data.value || 1;
  const percent = (amount: number) => `${Math.min(100, (amount / scale) * 100).toFixed(1)}%`;

  const facts: Array<{ title: string; detail: string; warn?: boolean }> = [
    {
      title: `Estimation ${formatPrice(data.value)}`,
      detail: `Fourchette ${formatPrice(data.valueLow)} à ${formatPrice(data.valueHigh)}${data.estimateQuality ? `, fiabilité ${data.estimateQuality}` : ""}`,
    },
    {
      title: `${formatNumber(data.comparables)} ventes à moins de ${formatNumber(data.radiusM)} m`,
      detail: `Médiane ${formatNumber(data.medianPricePerM2)} €/m², ${formatNumber(data.yearsBack)} ans de DVF`,
    },
    ...(data.sameBuilding
      ? [
          {
            title: `Même immeuble : ${formatPrice(data.sameBuilding.totalPrice)}`,
            detail: `${data.sameBuilding.surface ? `${formatNumber(data.sameBuilding.surface)} m² vendus` : "Vendu"} en ${data.sameBuilding.month} ${data.sameBuilding.year}`,
          },
        ]
      : []),
    {
      title: `Mise à prix ${formatNumber(data.startingGapPct)} % sous le marché`,
      detail: `${formatNumber(data.startingPricePerM2)} €/m² contre ${formatNumber(data.medianPricePerM2)} €/m²`,
    },
    {
      title: "Occupation à confirmer",
      detail: `Occupant déclaré, bail non produit${data.occupationPage ? ` (PV p. ${data.occupationPage})` : ""}`,
      warn: true,
    },
    {
      title: "État et énergie",
      detail: [data.condition, data.dpe ? `DPE ${data.dpe}` : null].filter(Boolean).join(", "),
    },
    {
      title: "Frais de la vente",
      detail: `${data.registrationRatePct ? `Droits de ${formatNumber(data.registrationRatePct)} %, ` : ""}émoluments, frais préalables`,
    },
    { title: "Portage et marge", detail: "Charges, taxe foncière, financement, marge" },
  ];

  const toConfirm = facts.filter((fact) => fact.warn).length;

  return (
    <section
      id="essayer"
      className={`${styles.section} ${styles.tryAnchor}`}
      aria-labelledby="try-title"
    >
      <div className={`${styles.container} ${styles.trySplit}`}>
        <div
          ref={card}
          className={styles.tryCard}
          data-reveal=""
          role="group"
          aria-label={`Exemple fictif : simulateur du verdict pour un T3 à ${data.city}`}
          {...loop.handlers}
        >
          <div className={styles.tryTop}>
            <div>
              <b>
                Appartement T3 de {data.surfaceM2}&nbsp;m² à {data.city}
              </b>
              <span>
                {data.floor ? `${data.floor} · ` : ""}balcon · mise à prix{" "}
                {formatPrice(data.startingPrice)}
              </span>
            </div>
            <span className={styles.tag}>Exemple fictif</span>
          </div>
          <div>
            <p className={styles.tryDataHead}>
              <b>Ce qu’Immojudis a croisé</b>
              <span>
                {facts.length} données croisées, {toConfirm} à confirmer
              </span>
            </p>
            <ul className={styles.tryData}>
              {facts.map((fact, position) => (
                <li
                  key={fact.title}
                  className={fact.warn ? styles.analysisWarn : undefined}
                  style={{ "--i": position } as React.CSSProperties}
                >
                  <span className={styles.analysisCheck} aria-hidden>
                    {fact.warn ? "!" : <Check size={10} />}
                  </span>
                  <b>{fact.title}</b> <span>{fact.detail}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className={styles.tryControls}>
            <Segmented
              label="Projet"
              options={EXAMPLE_PROJECTS}
              labels={PROJECT_LABEL}
              value={choice.project}
              onChange={(project) => choose({ project })}
            />
            <Segmented
              label="Occupation"
              options={EXAMPLE_OCCUPATIONS}
              labels={OCCUPATION_LABEL}
              value={choice.occupation}
              onChange={(occupation) => choose({ occupation })}
            />
            <Segmented
              label="Travaux"
              options={EXAMPLE_WORKS}
              labels={WORKS_LABEL}
              value={choice.works}
              onChange={(works) => choose({ works })}
            />
          </div>
          <div className={`${styles.tryVerdict} ${styles[`verdict_${verdict}`]}`}>
            <div className={styles.tryVerdictTop}>
              <small>Votre enchère plafond</small>
              <span className={styles.verdictPill}>
                <i aria-hidden />
                {BID_VERDICT_LABEL[verdict]}
              </span>
            </div>
            <p className={styles.verdictAmount} aria-hidden>
              {formatPrice(shown)}
            </p>
            {/* Annoncé en permanence : la valeur finale, jamais les montants intermédiaires du
                compteur animé (masqué ci-dessus). */}
            <p className="sr-only" role="status">
              Votre enchère plafond : {formatPrice(ceiling)}. {BID_VERDICT_LABEL[verdict]}.
            </p>
            <p className={styles.verdictText}>{bidVerdictSentence(ceiling, data.startingPrice)}</p>
            <div className={styles.gauge} aria-hidden>
              <span
                className={styles.gaugeBand}
                style={{
                  left: percent(data.valueLow),
                  width: `${(((data.valueHigh - data.valueLow) / scale) * 100).toFixed(1)}%`,
                }}
              />
              <span className={styles.gaugeFill} style={{ width: percent(ceiling) }} />
              <span className={styles.gaugeMark} style={{ left: percent(data.startingPrice) }}>
                <span>Mise à prix</span>
              </span>
              <span
                className={`${styles.gaugeMark} ${styles.gaugeMarkEnd}`}
                style={{ left: percent(data.value) }}
              >
                <span>Valeur</span>
              </span>
            </div>
            <p className={styles.gaugeAxis} aria-hidden>
              <span>0 €</span>
              <span>Fourchette d’estimation</span>
            </p>
            {scenario ? <p className={styles.tryWhy}>{scenarioExplanation(scenario)}</p> : null}
          </div>
          <div className={styles.exampleFoot}>
            <p className={`${styles.tryHint} ${touched ? styles.tryHintOff : ""}`}>
              <i aria-hidden />
              Changez votre projet, l’occupation ou les travaux.
            </p>
            <button
              type="button"
              className={`${styles.pauseButton} ${loop.running ? "" : styles.pauseButtonOff}`}
              aria-pressed={loop.paused}
              tabIndex={loop.running ? undefined : -1}
              onClick={loop.togglePause}
            >
              Mettre en pause l’animation
            </button>
          </div>
          <p>
            <Link href="/annonce-exemple" prefetch={false} className={styles.textLink}>
              Voir l’analyse complète <ArrowRight aria-hidden size={16} />
            </Link>
          </p>
        </div>
        <div className={`${styles.head} ${styles.headAside}`} data-reveal="">
          <p className={styles.eyebrow}>Essayez sur un exemple</p>
          <h2 id="try-title" className={styles.h2}>
            Enchérir ou passer son tour : la réponse dépend de votre projet.
          </h2>
          <p className={styles.lead}>
            Immojudis croise l’estimation, les ventes du quartier, les pièces de la vente et vos
            coûts. Changez un réglage : l’enchère plafond et le verdict se recalculent.
          </p>
          <p className={styles.lead}>
            La mise à prix est le montant à partir duquel démarrent les enchères ; ce n’est pas le
            prix final.
          </p>
          <ul className={styles.verdictRules}>
            <li className={styles.verdict_go}>
              <span aria-hidden>✓</span>
              <span>
                <b>{BID_VERDICT_LABEL.go}</b> quand le plafond dépasse la mise à prix d’au moins{" "}
                {TIGHT_MARGIN_LABEL}.
              </span>
            </li>
            <li className={styles.verdict_tight}>
              <span aria-hidden>~</span>
              <span>
                <b>{BID_VERDICT_LABEL.tight}</b> quand la marge est de moins de {TIGHT_MARGIN_LABEL}
                .
              </span>
            </li>
            <li className={styles.verdict_pass}>
              <span aria-hidden>×</span>
              <span>
                <b>{BID_VERDICT_LABEL.pass}</b> quand la mise à prix dépasse déjà le plafond.
              </span>
            </li>
          </ul>
          <p>
            <Link href="/annonce-exemple" prefetch={false} className={styles.textLink}>
              Voir l’analyse complète de l’exemple <ArrowRight aria-hidden size={16} />
            </Link>
          </p>
        </div>
      </div>
    </section>
  );
}
