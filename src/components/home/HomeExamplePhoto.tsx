"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { bidVerdict, bidVerdictSentence, BID_VERDICT_LABEL } from "@/lib/bid-verdict";
import { formatNumber, formatPrice } from "@/lib/format";
import { Check } from "./HomeIcons";
import { useCountTo } from "./use-count-to";
import styles from "./HomePage.module.css";

export type ExamplePhotoPreset = { label: string; button: string; ceiling: number };

export type ExamplePhotoProps = {
  /** Première photo de l'annonce exemple, la même que sur /annonce-exemple. */
  photo: string;
  surfaceM2: number;
  city: string;
  hearingInDays: number;
  startingPrice: number;
  value: number;
  comparables: number;
  radiusM: number;
  sameBuildingYear: number | null;
  sameBuildingPrice: number | null;
  startingGapPct: number;
  dpe: string | null;
  presets: ExamplePhotoPreset[];
};

const CYCLE_MS = 3_400;
const FIRST_CYCLE_MS = 4_200;

/**
 * Premier écran : la photo de l'annonce exemple, un panneau « Analyse du bien » (les données
 * croisées) et le verdict. Trois situations défilent seules, du vert au rouge, tant que le visiteur
 * n'a pas choisi la sienne ; rien ne défile quand il réduit les animations.
 */
export function HomeExamplePhoto(props: ExamplePhotoProps) {
  const { presets, startingPrice } = props;
  const [index, setIndex] = useState(0);
  const [chosen, setChosen] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (chosen || presets.length < 2) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let interval: number | null = null;
    timer.current = window.setTimeout(() => {
      interval = window.setInterval(
        () => setIndex((current) => (current + 1) % presets.length),
        CYCLE_MS,
      );
    }, FIRST_CYCLE_MS);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
      if (interval) window.clearInterval(interval);
    };
  }, [chosen, presets.length]);

  const preset = presets[index] ?? presets[0];
  const verdict = bidVerdict(preset.ceiling, startingPrice);
  const shown = useCountTo(preset.ceiling);

  const rows: Array<{ label: string; value: string; warn?: boolean }> = [
    { label: "Estimation", value: formatPrice(props.value) },
    {
      label: `Ventes à moins de ${formatNumber(props.radiusM)} m`,
      value: formatNumber(props.comparables),
    },
    ...(props.sameBuildingPrice && props.sameBuildingYear
      ? [
          {
            label: `Même immeuble, ${props.sameBuildingYear}`,
            value: formatPrice(props.sameBuildingPrice),
          },
        ]
      : []),
    { label: "Mise à prix face au marché", value: `−${formatNumber(props.startingGapPct)} %` },
    { label: "Occupation", value: "À confirmer", warn: true },
    ...(props.dpe ? [{ label: "DPE", value: props.dpe }] : []),
    { label: "Frais, travaux, portage", value: "Chiffrés" },
  ];

  return (
    <figure
      className={`${styles.examplePhoto} ${styles.heroAnim}`}
      style={{ "--delay": "200ms" } as React.CSSProperties}
      aria-label={`Exemple fictif : analyse et verdict pour un appartement de ${props.surfaceM2} m² à ${props.city}`}
    >
      <Image
        src={props.photo}
        alt="Séjour d’un appartement ancien, parquet et grandes fenêtres (photo d’illustration)"
        fill
        // La photo (16:9, 1 600 px) remplit un cadre plus haut que large : elle s'affiche environ deux
        // fois plus large que le cadre (trois fois sur mobile). Demander la largeur du cadre la ferait
        // agrandir, donc floue.
        sizes="(max-width: 960px) 310vw, 1040px"
        quality={85}
        loading="eager"
        fetchPriority="high"
        className={styles.examplePhotoImage}
      />
      <div className={styles.examplePhotoShade} aria-hidden />
      <div className={styles.exampleTop}>
        <span className={styles.glass}>
          <span>
            T3 de {props.surfaceM2}&nbsp;m², balcon · {props.city}
            <small>Tribunal judiciaire · audience dans {props.hearingInDays} jours</small>
          </span>
        </span>
        <span className={styles.glass}>Exemple fictif</span>
      </div>
      <div className={styles.analysisPanel}>
        <p className={styles.analysisHead}>
          <span>Analyse du bien</span>
          <span>
            {rows.length} sur {rows.length}
          </span>
        </p>
        <ul>
          {rows.map((row, position) => (
            <li
              key={row.label}
              className={row.warn ? styles.analysisWarn : undefined}
              style={{ "--i": position } as React.CSSProperties}
            >
              <span className={styles.analysisCheck} aria-hidden>
                {row.warn ? "!" : <Check size={9} />}
              </span>
              <span>{row.label}</span> <b>{row.value}</b>
            </li>
          ))}
        </ul>
      </div>
      <div
        className={`${styles.photoVerdict} ${styles[`verdict_${verdict}`]}`}
        aria-live={chosen ? "polite" : "off"}
      >
        <div className={styles.photoVerdictRow}>
          <div>
            <span className={styles.photoVerdictLabel}>{preset.label}</span>
            <p className={styles.verdictAmount}>{formatPrice(shown)}</p>
          </div>
          <span className={styles.verdictPill}>
            <i aria-hidden />
            {BID_VERDICT_LABEL[verdict]}
          </span>
        </div>
        <p className={styles.verdictText}>{bidVerdictSentence(preset.ceiling, startingPrice)}</p>
        <div className={styles.presetButtons} role="group" aria-label="Situations de l’exemple">
          {presets.map((item, position) => (
            <button
              key={item.button}
              type="button"
              aria-pressed={position === index}
              onClick={() => {
                setChosen(true);
                setIndex(position);
              }}
            >
              {item.button}
            </button>
          ))}
        </div>
      </div>
    </figure>
  );
}
