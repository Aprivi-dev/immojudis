import Link from "next/link";
import type { CSSProperties } from "react";
import {
  exampleVerdictData,
  findExampleScenario,
  type ExampleOccupation,
  type ExampleProject,
  type ExampleWorks,
} from "@/lib/example-verdict";
import { formatNumber, formatNumericDate } from "@/lib/format";
import type { HomeCatalogueSummary } from "@/lib/home-catalogue-summary.server";
import { isFeeRegimeOpen, type FeeRegimeKey } from "@/lib/fee-regime-open";
import { notaryAndStatePilotsEnabled } from "@/lib/sale-types";
import { HomeExamplePhoto, type ExamplePhotoProps } from "./HomeExamplePhoto";
import { HomePrimaryAction } from "./HomePrimaryAction";
import styles from "./HomePage.module.css";

function delay(ms: number): CSSProperties {
  return { "--delay": `${ms}ms` } as CSSProperties;
}

/**
 * « 1 753 ventes à venir · données vérifiées le 15/10/2026 » ; la date seule peut manquer. C'est la
 * date de la dernière collecte réussie, pas celle d'une modification d'annonce : la ligne ne dit pas
 * que les ventes ont « été mises à jour ».
 */
export function catalogueSummaryLine({ count, verifiedAt }: HomeCatalogueSummary): string {
  const sales = `${formatNumber(count)} vente${count > 1 ? "s" : ""} à venir`;
  const date = formatNumericDate(verifiedAt, "");
  return date ? `${sales} · données vérifiées le ${date}` : sales;
}

/** Premier écran : la promesse, l'action principale, les chiffres réels et la photo qui analyse. */
export function HomeHero({
  summary = null,
  departments = null,
  openFeeRegimes,
}: {
  summary?: HomeCatalogueSummary | null;
  departments?: number | null;
  /** Régimes dont le plafond est ouvert (`CEILING_FEE_REGIMES_OPEN`) ; absent : ceux par défaut. */
  openFeeRegimes?: readonly FeeRegimeKey[];
}) {
  // Le plafond existe pour le tribunal et, quand son régime est ouvert, pour la vente notariale ;
  // jamais pour les ventes de l'État.
  const notaryCeiling =
    isFeeRegimeOpen("notary_auction", openFeeRegimes) ||
    isFeeRegimeOpen("notary_online", openFeeRegimes);
  return (
    <section className={styles.hero} aria-labelledby="home-title">
      <div className={`${styles.container} ${styles.heroGrid}`}>
        <div className={styles.heroCopy}>
          <p className={`${styles.eyebrow} ${styles.heroAnim}`}>
            Pour acheter aux enchères en sachant jusqu’où monter
          </p>
          <h1 id="home-title" className={styles.heroAnim} style={delay(80)}>
            Les enchères <br />
            immobilières, <br />
            en toute <span className={styles.clarte}>clarté.</span>
          </h1>
          <p className={`${styles.lead} ${styles.heroAnim}`} style={delay(160)}>
            Pour chaque vente au tribunal{notaryCeiling ? " et chez le notaire" : ""} : ce que
            disent les pièces quand elles sont publiées, la valeur du quartier et l’enchère à ne pas
            dépasser selon votre projet.{" "}
            {notaryAndStatePilotsEnabled()
              ? "Les ventes des tribunaux, des notaires et de l’État sur une carte."
              : "Les ventes des tribunaux sur une carte."}
          </p>
          <div className={styles.heroAnim} style={delay(240)}>
            <HomePrimaryAction browseLink />
          </div>
          {summary ? (
            <p className={`${styles.proof} ${styles.heroAnim}`} style={delay(320)}>
              <Link href="/sales" prefetch={false}>
                <span className={styles.proofDot} aria-hidden />
                <span className={styles.proofFigure}>
                  <b>{formatNumber(summary.count)}</b> vente{summary.count > 1 ? "s" : ""} à venir
                </span>
                {departments ? (
                  <>
                    {" "}
                    <span className={styles.proofSep} aria-hidden>
                      ·
                    </span>{" "}
                    <span>
                      <b>{formatNumber(departments)}</b> département{departments > 1 ? "s" : ""}
                    </span>
                  </>
                ) : null}
                {formatNumericDate(summary.verifiedAt, "") ? (
                  <>
                    {" "}
                    <span className={styles.proofSep} aria-hidden>
                      ·
                    </span>{" "}
                    <span>données vérifiées le {formatNumericDate(summary.verifiedAt, "")}</span>
                  </>
                ) : null}
              </Link>
            </p>
          ) : null}
        </div>
        <HomeExamplePhoto {...photoProps()} />
      </div>
    </section>
  );
}

/** Les trois situations du premier écran, du vert au rouge (calculées par le moteur). */
function photoProps(): ExamplePhotoProps {
  const data = exampleVerdictData();
  // Un scénario absent est une erreur de l'exemple (le test de l'accueil la rattrape), pas un
  // « 0 € » affiché sur le premier écran.
  const ceilingOf = (
    project: ExampleProject,
    occupation: ExampleOccupation,
    works: ExampleWorks,
  ): number => {
    const scenario = findExampleScenario(data.scenarios, project, occupation, works);
    if (!scenario)
      throw new Error(`Scénario d’exemple absent : ${project}, ${occupation}, ${works}`);
    return scenario.ceiling;
  };
  return {
    photo: data.photo,
    surfaceM2: data.surfaceM2,
    city: data.city,
    hearingInDays: data.hearingInDays,
    startingPrice: data.startingPrice,
    value: data.value,
    valueLow: data.valueLow,
    valueHigh: data.valueHigh,
    comparables: data.comparables,
    radiusM: data.radiusM,
    sameBuildingYear: data.sameBuilding?.year ?? null,
    sameBuildingPrice: data.sameBuilding?.totalPrice ?? null,
    startingPricePerM2: data.startingPricePerM2,
    medianPricePerM2: data.medianPricePerM2,
    dpe: data.dpe,
    presets: [
      {
        button: "Y habiter",
        label: "Pour y habiter, occupé, rafraîchissement",
        ceiling: ceilingOf("habiter", "occupe", "rafraichissement"),
      },
      {
        button: "Revendre, loué",
        label: "Pour revendre, bien loué, rafraîchissement",
        ceiling: ceilingOf("revendre", "loue", "rafraichissement"),
      },
      {
        button: "Louer après rénovation",
        label: "Pour louer, occupé, rénovation confort",
        ceiling: ceilingOf("louer", "occupe", "confort"),
      },
    ],
  };
}
