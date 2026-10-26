import Link from "next/link";
import type { CSSProperties } from "react";
import {
  exampleVerdictData,
  findExampleScenario,
  type ExampleOccupation,
  type ExampleProject,
  type ExampleWorks,
} from "@/lib/example-verdict";
import { formatNumber } from "@/lib/format";
import type { HomeCatalogueSummary } from "@/lib/home-catalogue-summary.server";
import { notaryAndStatePilotsEnabled } from "@/lib/sale-types";
import { HomeExamplePhoto, type ExamplePhotoProps } from "./HomeExamplePhoto";
import { HomePrimaryAction } from "./HomePrimaryAction";
import styles from "./HomePage.module.css";

const UPDATE_DATE_FORMAT = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "Europe/Paris",
});

function delay(ms: number): CSSProperties {
  return { "--delay": `${ms}ms` } as CSSProperties;
}

function verifiedDate(verifiedAt: string | null): string | null {
  const date = verifiedAt ? new Date(verifiedAt) : null;
  return date && Number.isFinite(date.getTime()) ? UPDATE_DATE_FORMAT.format(date) : null;
}

/**
 * « 1 753 ventes à venir · données vérifiées le 15/10/2026 » ; la date seule peut manquer. C'est la
 * date de la dernière collecte réussie, pas celle d'une modification d'annonce : la ligne ne dit pas
 * que les ventes ont « été mises à jour ».
 */
export function catalogueSummaryLine({ count, verifiedAt }: HomeCatalogueSummary): string {
  const sales = `${formatNumber(count)} vente${count > 1 ? "s" : ""} à venir`;
  const date = verifiedDate(verifiedAt);
  return date ? `${sales} · données vérifiées le ${date}` : sales;
}

/** Premier écran : la promesse, l'action principale, les chiffres réels et la photo qui analyse. */
export function HomeHero({
  summary = null,
  departments = null,
}: {
  summary?: HomeCatalogueSummary | null;
  departments?: number | null;
}) {
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
            {notaryAndStatePilotsEnabled()
              ? "Les ventes des tribunaux, des notaires et de l’État réunies sur une carte."
              : "Les ventes des tribunaux réunies sur une carte."}{" "}
            Pour les ventes au tribunal, les pièces lues et l’enchère à ne pas dépasser.
          </p>
          <div className={styles.heroAnim} style={delay(240)}>
            <HomePrimaryAction />
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
                {verifiedDate(summary.verifiedAt) ? (
                  <>
                    {" "}
                    <span className={styles.proofSep} aria-hidden>
                      ·
                    </span>{" "}
                    <span>données vérifiées le {verifiedDate(summary.verifiedAt)}</span>
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
  const ceilingOf = (project: ExampleProject, occupation: ExampleOccupation, works: ExampleWorks) =>
    findExampleScenario(data.scenarios, project, occupation, works)?.ceiling ?? 0;
  return {
    photo: data.photo,
    surfaceM2: data.surfaceM2,
    city: data.city,
    hearingInDays: data.hearingInDays,
    startingPrice: data.startingPrice,
    value: data.value,
    comparables: data.comparables,
    radiusM: data.radiusM,
    sameBuildingYear: data.sameBuilding?.year ?? null,
    sameBuildingPrice: data.sameBuilding?.totalPrice ?? null,
    startingGapPct: data.startingGapPct,
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
