"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchDocumentReading } from "@/lib/client-api";
import * as queryKeys from "@/lib/query-keys";
import type { SaleAccessMode } from "@/lib/query-keys";
import {
  DOCUMENT_READING_IMPORTANCE,
  DOCUMENT_READING_THEMES,
  documentPageHref,
  groupReadingPoints,
  readingHighlights,
  type DocumentReadingResponse,
} from "@/lib/document-reading";
import styles from "./DocumentReadingSection.module.css";
import { UnlockCallToAction } from "./UnlockCallToAction";

function plural(count: number, word: string): string {
  return `${count} ${word}${count > 1 ? "s" : ""}`;
}

type ReadingQueryArgs = {
  saleId: string;
  enabled: boolean;
  access: SaleAccessMode;
  userKey: string | null;
};

/** Une seule lecture par vente et par compte, partagée par l'encart de tête et la section des pièces. */
function useDocumentReading({ saleId, enabled, access, userKey }: ReadingQueryArgs) {
  return useQuery<DocumentReadingResponse>({
    queryKey: queryKeys.documentReading(saleId, access, userKey),
    queryFn: () => fetchDocumentReading(saleId),
    enabled,
    staleTime: 10 * 60_000,
    retry: false,
  });
}

/**
 * « Ce que disent les pièces », sous la description de la fiche : les trois points les plus importants
 * de la lecture des pièces, chacun renvoyant à sa citation dans la section 05. Un compte gratuit n'en
 * voit que le nombre, comme dans la section. Rien tant que la lecture n'a pas de point à montrer.
 */
export function DocumentReadingHighlights({
  saleId,
  enabled,
  access = "discovery",
  userKey = null,
}: {
  saleId: string;
  enabled: boolean;
  access?: SaleAccessMode;
  userKey?: string | null;
}) {
  const { data } = useDocumentReading({ saleId, enabled, access, userKey });
  if (!enabled || !data) return null;
  if (data.access === "teaser") {
    if (!data.pointCount) return null;
    return (
      <aside className={styles.highlights} aria-labelledby="reading-highlights-title">
        <h3 id="reading-highlights-title">Ce que disent les pièces</h3>
        <p className={styles.lead}>
          {plural(data.pointCount, "point")} relevé{data.pointCount > 1 ? "s" : ""} dans les pièces
          {data.alertCount ? `, dont ${data.alertCount} à vérifier en priorité` : ""}.{" "}
          <a href="#pieces" className={styles.cta}>
            Voir la lecture des pièces
          </a>
        </p>
      </aside>
    );
  }
  if (data.status !== "completed" || !data.points.length) return null;
  return (
    <aside className={styles.highlights} aria-labelledby="reading-highlights-title">
      <h3 id="reading-highlights-title">Ce que disent les pièces</h3>
      <ul className={styles.highlightList}>
        {readingHighlights(data.points).map((point, index) => (
          <li key={index} className={styles.pointHeader}>
            <span className={`${styles.badge} ${styles[point.importance]}`}>
              {DOCUMENT_READING_IMPORTANCE[point.importance]}
            </span>
            <span className={styles.pointTitle}>{point.title}</span>
            <span className={styles.source}>
              {point.document?.label ?? "Pièce du dossier"}, page {point.page}
            </span>
          </li>
        ))}
      </ul>
      <a href="#pieces" className={styles.cta}>
        {data.points.length > 3
          ? `Voir les ${data.points.length} points et leurs citations`
          : "Voir les citations dans les pièces"}
      </a>
    </aside>
  );
}

/**
 * « Lecture des pièces »: what the case documents say about occupation, works,
 * diagnostics, co-ownership… Every point quotes the document and links to the
 * cited page. A free account only learns how many points were found, until it unlocks the sale.
 */
export function DocumentReadingSection({
  saleId,
  enabled,
  access = "discovery",
  userKey = null,
}: {
  saleId: string;
  enabled: boolean;
  /** The view the account reads: its key keeps the free teaser out of an unlocked sale's cache. */
  access?: SaleAccessMode;
  /** The signed-in account, so that a cached reading never crosses accounts. */
  userKey?: string | null;
}) {
  const query = useDocumentReading({ saleId, enabled, access, userKey });
  if (!enabled) return null;
  // Trois états visibles avant la lecture, à hauteur réservée : chargement, erreur (avec
  // « Réessayer ») et pièces non lisibles. Aucun ne dépend de ce que le compte a le droit de lire :
  // le cas « teaser » plus bas reste inchangé.
  if (!query.data) {
    return (
      <section
        id="lecture-pieces"
        className={`${styles.card} ${styles.placeholder}`}
        aria-labelledby="document-reading-title"
        aria-busy={!query.isError}
      >
        <h2 id="document-reading-title">Lecture des pièces du dossier</h2>
        {query.isError ? (
          <>
            <p role="alert" className={styles.lead}>
              La lecture des pièces n’a pas pu être chargée.
            </p>
            <button
              type="button"
              className={styles.stateAction}
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
            >
              Réessayer
            </button>
          </>
        ) : (
          <p role="status" className={styles.lead}>
            Lecture des pièces en cours…
          </p>
        )}
      </section>
    );
  }
  const data = query.data;

  if (data.access === "teaser") {
    if (!data.pointCount) return null;
    const themes = data.themes.map((theme) => DOCUMENT_READING_THEMES[theme].toLowerCase());
    return (
      <section id="lecture-pieces" className={styles.card} aria-labelledby="document-reading-title">
        <h2 id="document-reading-title">Lecture des pièces du dossier</h2>
        <p className={styles.lead}>
          {plural(data.pointCount, "point")} relevé{data.pointCount > 1 ? "s" : ""} dans les pièces
          {data.alertCount ? `, dont ${data.alertCount} à vérifier en priorité` : ""}
          {themes.length ? ` : ${themes.join(", ")}.` : "."} Chaque point cite le passage et la page
          de la pièce, avec l’offre Analyse ou en débloquant cette vente.
        </p>
        <UnlockCallToAction
          primaryClassName={styles.cta}
          secondaryClassName={`${styles.cta} ${styles.ctaSecondary}`}
          messageClassName={styles.lead}
        />
      </section>
    );
  }

  if (data.status === "no_text") {
    return (
      <section
        id="lecture-pieces"
        className={`${styles.card} ${styles.placeholder}`}
        aria-labelledby="document-reading-title"
      >
        <h2 id="document-reading-title">Lecture des pièces du dossier</h2>
        <p className={styles.lead}>
          Les pièces de ce dossier n’ont pas pu être lues automatiquement (documents numérisés).
          Lisez-les directement :
        </p>
        <a href="#documents" className={styles.stateAction}>
          Voir les pièces disponibles
        </a>
      </section>
    );
  }
  if (data.status !== "completed") {
    return (
      <section id="lecture-pieces" className={styles.card} aria-labelledby="document-reading-title">
        <h2 id="document-reading-title">Lecture des pièces du dossier</h2>
        <p className={styles.lead}>
          La lecture des pièces de cette vente est en préparation. Elle apparaîtra ici dès que les
          documents auront été lus.
        </p>
      </section>
    );
  }

  const groups = groupReadingPoints(data.points);
  return (
    <section id="lecture-pieces" className={styles.card} aria-labelledby="document-reading-title">
      <h2 id="document-reading-title">Lecture des pièces du dossier</h2>
      <p className={styles.lead}>
        {data.points.length
          ? `${plural(data.points.length, "point")} relevé${data.points.length > 1 ? "s" : ""} dans les pièces. Chaque point cite le passage de la pièce (noms de personnes remplacés par leur rôle) : vérifiez-le dans la pièce et faites-le confirmer par votre avocat.`
          : "Aucun point particulier relevé dans les pièces lues. Lisez-les quand même en entier avec votre avocat."}
      </p>
      {groups.map((group) => (
        <div key={group.theme} className={styles.theme}>
          <h3>{DOCUMENT_READING_THEMES[group.theme]}</h3>
          {group.points.map((point, index) => {
            const href = documentPageHref(point.document?.url ?? null, point.page);
            const source = `${point.document?.label ?? "Pièce du dossier"}, page ${point.page}`;
            return (
              <article key={`${group.theme}-${index}`} className={styles.point}>
                <div className={styles.pointHeader}>
                  <p className={styles.pointTitle}>{point.title}</p>
                  <span className={`${styles.badge} ${styles[point.importance]}`}>
                    {DOCUMENT_READING_IMPORTANCE[point.importance]}
                  </span>
                </div>
                {point.explanation ? (
                  <p className={styles.explanation}>{point.explanation}</p>
                ) : null}
                <blockquote className={styles.quote}>« {point.quote} »</blockquote>
                <p className={styles.source}>
                  {href ? (
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {source}
                    </a>
                  ) : (
                    source
                  )}
                </p>
              </article>
            );
          })}
        </div>
      ))}
      <p className={styles.note}>
        Lecture automatique des pièces publiées
        {data.partial ? " (pour les dossiers volumineux, les pages les plus utiles)" : ""}. Seuls
        les points dont la citation a été retrouvée mot pour mot dans la pièce sont affichés ; les
        noms de personnes y sont remplacés par leur rôle. Cette lecture ne remplace ni la lecture
        complète du dossier ni le conseil de votre avocat.
      </p>
    </section>
  );
}
