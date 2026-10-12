import Link from "next/link";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import styles from "./Resources.module.css";

export function ResourcesNextStep() {
  return (
    <section className={styles.nextStep} aria-labelledby="next-step-title">
      <div>
        <p className={styles.eyebrow}>De la lecture à la pratique</p>
        <h2 id="next-step-title">
          Un dossier en vue ?<br />
          Prenez le temps de l’analyser.
        </h2>
        <p>
          Retrouvez les annonces référencées, leurs documents disponibles et les points à vérifier
          avant de vous engager.
        </p>
      </div>
      <Link href="/sales" className={styles.primaryLink}>
        Explorer les ventes <ArrowRight size={18} aria-hidden="true" />
      </Link>
    </section>
  );
}
