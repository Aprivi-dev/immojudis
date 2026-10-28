"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { bidVerdict, bidVerdictSentence, BID_VERDICT_LABEL } from "@/lib/bid-verdict";
import { formatNumber, formatPrice } from "@/lib/format";
import { ArrowRight, Check } from "./HomeIcons";
import { useCountTo } from "./use-count-to";
import { useDemoLoop } from "./use-demo-loop";
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
  /** Fourchette de l'estimation ; 0 quand elle manque (rien ne s'affiche alors). */
  valueLow: number;
  valueHigh: number;
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
const ANALYSIS_HREF = "/annonce-exemple";

/**
 * Premier écran : la fiche de l'annonce exemple sur un panneau blanc (photo en vignette, panneau
 * « Analyse du bien » avec les données croisées), puis l'estimation et l'enchère à ne pas dépasser
 * côte à côte. Les trois situations défilent une fois, du vert au rouge, tant que le visiteur ne
 * survole pas la carte, n'y a pas le focus, ne la touche pas et n'a pas choisi la sienne (bouton
 * « Mettre en pause l'animation » ; rien ne défile quand il réduit les animations).
 */
export function HomeExamplePhoto(props: ExamplePhotoProps) {
  const { presets, startingPrice } = props;
  const loop = useDemoLoop({ steps: presets.length, firstMs: FIRST_CYCLE_MS, stepMs: CYCLE_MS });
  const [chosenIndex, setChosenIndex] = useState<number | null>(null);
  const index = chosenIndex ?? loop.step;

  const preset = presets[index] ?? presets[0];
  const verdict = bidVerdict(preset.ceiling, startingPrice);
  const shown = useCountTo(preset.ceiling);

  const rows: Array<{ label: string; value: string; warn?: boolean }> = [
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
  const range =
    props.valueLow > 0 && props.valueHigh > props.valueLow
      ? `${formatNumber(props.valueLow)} – ${formatPrice(props.valueHigh)}`
      : null;

  return (
    <div
      className={`${styles.exampleStage} ${styles.heroAnim}`}
      style={{ "--delay": "200ms" } as React.CSSProperties}
    >
      <figure
        className={styles.exampleCard}
        aria-label={`Exemple fictif : analyse et verdict pour un appartement de ${props.surfaceM2} m² à ${props.city}`}
        {...loop.handlers}
      >
        <div className={styles.exampleHeader}>
          <div className={styles.exampleThumb}>
            <Image
              src={props.photo}
              alt="Séjour d’un appartement ancien, parquet et grandes fenêtres (photo d’illustration)"
              fill
              sizes="(max-width: 520px) 128px, 200px"
              quality={85}
              loading="eager"
              fetchPriority="high"
              className={styles.exampleThumbImage}
            />
            <span className={styles.exampleBadge}>Exemple fictif</span>
          </div>
          <div className={styles.exampleTitle}>
            <p>
              T3 de {props.surfaceM2}&nbsp;m², balcon · {props.city}
            </p>
            <p className={styles.exampleSub}>
              Tribunal judiciaire · audience dans {props.hearingInDays} jours
            </p>
            <p className={styles.exampleChip}>
              Mise à prix <b>{formatPrice(startingPrice)}</b>
            </p>
          </div>
        </div>

        <div className={styles.analysisBlock}>
          <p className={styles.analysisHead}>
            <span>Analyse du bien</span>{" "}
            <span>
              {rows.filter((row) => !row.warn).length} sur {rows.length} confirmés
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

        <div>
          <div className={styles.exampleTiles}>
            <div className={styles.valueTile}>
              <span className={styles.tileLabel}>Estimation</span>{" "}
              <p className={styles.tileAmount}>{formatPrice(props.value)}</p>
              {range ? <span className={styles.tileNote}>Fourchette : {range}</span> : null}
            </div>
            <div className={`${styles.ceilingTile} ${styles[`verdict_${verdict}`]}`}>
              <span className={styles.tileLabel}>Enchère à ne pas dépasser</span>{" "}
              <p className={styles.verdictAmount} aria-hidden>
                {formatPrice(shown)}
              </p>
              <span className={styles.verdictPill}>
                <i aria-hidden />
                {BID_VERDICT_LABEL[verdict]}
              </span>
            </div>
          </div>
          <p className={`${styles.exampleSituation} ${styles[`verdict_${verdict}`]}`}>
            <span className={styles.situationLabel}>{preset.label}</span>{" "}
            <span className={styles.verdictText}>
              {bidVerdictSentence(preset.ceiling, startingPrice)}
            </span>
          </p>
          {/* Zone annoncée en permanence : la valeur finale, jamais les montants intermédiaires
              du compteur animé (masqués ci-dessus). */}
          <p className="sr-only" role="status">
            Enchère à ne pas dépasser : {formatPrice(preset.ceiling)}. {BID_VERDICT_LABEL[verdict]}.
          </p>
        </div>
        <div className={styles.presetButtons} role="group" aria-label="Situations de l’exemple">
          {presets.map((item, position) => (
            <button
              key={item.button}
              type="button"
              aria-pressed={position === index}
              onClick={() => {
                loop.stop();
                setChosenIndex(position);
              }}
            >
              {item.button}
            </button>
          ))}
        </div>
        <div className={styles.exampleFoot}>
          <Link href={ANALYSIS_HREF} prefetch={false} className={styles.textLink}>
            Voir l’analyse complète <ArrowRight aria-hidden size={16} />
          </Link>
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
      </figure>
    </div>
  );
}
