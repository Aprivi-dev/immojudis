import type { AuctionSale } from "@/lib/types";
import {
  getPropertyCharacteristics,
  stateListingStatus,
  type CharacteristicItem,
} from "@/lib/property-characteristics";
import styles from "./ListingCharacteristics.module.css";

function Facts({ items }: { items: CharacteristicItem[] }) {
  return (
    <dl className={styles.facts}>
      {items.map((item) => (
        <div key={`${item.label}:${item.value}`}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Bloc « Caractéristiques du bien » : tuiles libellé/valeur publiées par la
 * source, surfaces par portée, procédure, pièces et service gestionnaire.
 * Rien n'est affiché quand la source ne publie aucune caractéristique.
 */
export function ListingCharacteristics({ sale }: { sale: AuctionSale }) {
  const model = getPropertyCharacteristics(sale);
  if (!model) return null;
  const listing = stateListingStatus(sale);
  const [primaryGroup, ...otherGroups] = model.groups;
  const sourceLabel =
    model.origin === "source" ? "Informations publiées sur la fiche officielle" : null;

  return (
    <section
      id="caracteristiques"
      className={`${styles.section} scroll-mt-36`}
      aria-labelledby="caracteristiques-title"
    >
      <div className={styles.header}>
        <h2 id="caracteristiques-title" className={styles.heading}>
          Caractéristiques du bien
        </h2>
        {sourceLabel ? <p className={styles.note}>{sourceLabel}</p> : null}
      </div>

      {model.nature.length || model.category || listing || model.procedure?.method ? (
        <ul className={styles.badges} aria-label="Nature et procédure">
          {model.nature.map((nature) => (
            <li key={nature} className={styles.badge}>
              {nature}
            </li>
          ))}
          {!model.nature.length && model.category ? (
            <li className={styles.badge}>{model.category}</li>
          ) : null}
          {model.procedure?.method ? (
            <li className={styles.badge}>{model.procedure.method}</li>
          ) : null}
          {listing ? (
            <li className={`${styles.badge} ${styles.pending}`}>{listing.label}</li>
          ) : null}
        </ul>
      ) : null}
      {listing?.detail ? <p className={styles.note}>{listing.detail}</p> : null}

      {model.surfaces.length ? (
        <>
          <h3 className={styles.subheading}>Surfaces</h3>
          <Facts items={model.surfaces} />
        </>
      ) : null}

      {primaryGroup ? (
        <>
          <h3 className={styles.subheading}>{primaryGroup.title}</h3>
          <Facts items={primaryGroup.items} />
        </>
      ) : null}

      {model.procedure && (model.procedure.facts.length || model.procedure.visits.length) ? (
        <>
          <h3 className={styles.subheading}>Procédure de vente</h3>
          {model.procedure.facts.length ? <Facts items={model.procedure.facts} /> : null}
          {model.procedure.visits.length ? (
            <ul className={`${styles.list} mt-2`} aria-label="Visites">
              {model.procedure.visits.map((visit) => (
                <li key={visit}>{visit}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      {otherGroups.length ||
      model.location.length ||
      model.media.length ||
      model.attachments.length ||
      model.dates.length ||
      model.manager ? (
        <details className={styles.disclosure}>
          <summary>Toutes les caractéristiques publiées</summary>
          {otherGroups.map((group) => (
            <div key={group.key}>
              <h3 className={styles.subheading}>{group.title}</h3>
              <Facts items={group.items} />
            </div>
          ))}
          {model.location.length ? (
            <>
              <h3 className={styles.subheading}>Localisation cadastrale</h3>
              <Facts items={model.location} />
            </>
          ) : null}
          {model.media.length ? (
            <>
              <h3 className={styles.subheading}>Galerie de la fiche</h3>
              <Facts items={model.media} />
            </>
          ) : null}
          {model.attachments.length ? (
            <>
              <h3 className={styles.subheading}>
                {model.attachmentsAccess
                  ? "Pièces du dossier (accès réservé)"
                  : "Pièces jointes publiées"}
              </h3>
              <ul className={styles.list}>
                {model.attachments.map((attachment) => (
                  <li key={attachment.label}>
                    {attachment.label}
                    {attachment.count > 1 ? ` (${attachment.count})` : ""}
                  </li>
                ))}
              </ul>
              {model.attachmentsAccess ? (
                model.attachmentsAccess.note ? (
                  <p className={styles.note}>{model.attachmentsAccess.note}</p>
                ) : null
              ) : (
                <a href="#documents" className={styles.link}>
                  Consulter les pièces
                </a>
              )}
            </>
          ) : null}
          {model.manager ? (
            <>
              <h3 className={styles.subheading}>
                {model.manager.heading ?? "Service gestionnaire"}
              </h3>
              <p className={styles.note}>
                {model.manager.service ? <span>{model.manager.service}</span> : null}
                {model.manager.service && model.manager.email ? " · " : null}
                {model.manager.email ? (
                  <a className={styles.link} href={`mailto:${model.manager.email}`}>
                    {model.manager.email}
                  </a>
                ) : null}
              </p>
            </>
          ) : null}
          {model.dates.length ? (
            <>
              <h3 className={styles.subheading}>Fiche officielle</h3>
              <Facts items={model.dates} />
            </>
          ) : null}
        </details>
      ) : null}
    </section>
  );
}
