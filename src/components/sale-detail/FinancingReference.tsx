import { formatPrice } from "@/lib/format";
import styles from "./SaleOverview.module.css";

/**
 * Repère du panneau « Votre analyse » pendant la lecture de « Travaux et financement » : les
 * montants que cette section fait varier (travaux retenus, mensualité), à la place du repère marché.
 * `null` tant qu'aucun des deux n'est connu : le panneau garde alors le repère marché.
 */
export function financingReference(works: number | null, monthlyPayment: number | null) {
  if (works == null && monthlyPayment == null) return null;
  return (
    <div className={styles.marketReference} data-testid="financing-reference">
      <p className={styles.eyebrow}>Votre projet</p>
      {works != null ? (
        <p className={styles.muted}>
          Travaux retenus : <strong>{formatPrice(Math.round(works))}</strong>
        </p>
      ) : null}
      {monthlyPayment != null ? (
        <p className={styles.muted}>
          Mensualité estimée : <strong>{formatPrice(Math.round(monthlyPayment))}</strong> par mois
        </p>
      ) : null}
    </div>
  );
}
