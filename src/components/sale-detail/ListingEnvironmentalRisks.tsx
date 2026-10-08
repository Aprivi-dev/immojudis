import { ClimaScoreWidget } from "./ClimaScoreWidget";
import styles from "./ListingEnvironment.module.css";

export function ListingEnvironmentalRisks({
  city,
  postalCode,
}: {
  city: string | null;
  postalCode: string | null;
}) {
  if (!city) return null;
  return (
    <section className={styles.section} aria-labelledby="environmental-risks-title">
      <h2 id="environmental-risks-title" className={styles.heading}>
        Risques environnementaux
      </h2>
      <p className={styles.note}>
        Consultez gratuitement les sources officielles pour identifier les risques autour du bien.
        Le dossier foncier détaillé et ses contrôles sont inclus dans l’offre Analyse.
      </p>
      <a href="https://www.georisques.gouv.fr/" target="_blank" rel="noopener noreferrer">
        Consulter Géorisques gratuitement
      </a>
      <ClimaScoreWidget key={`${city}:${postalCode}`} city={city} postalCode={postalCode} />
    </section>
  );
}
