import { isUuid } from "@/lib/uuid";

type SaleIdentity = {
  id: string;
  source_name?: string | null;
  dedupe_confidence?: string | null;
};

const EXAMPLE_SALE_ID_PREFIX = "example-immojudis-";

function isHomepageExampleSale(sale: SaleIdentity): boolean {
  return (
    sale.id.startsWith(EXAMPLE_SALE_ID_PREFIX) ||
    sale.dedupe_confidence === "demo" ||
    sale.source_name?.toLocaleLowerCase("fr-FR").includes("démonstration immojudis") === true
  );
}

export function excludeHomepageExampleSales<TSale extends SaleIdentity>(sales: TSale[]): TSale[] {
  return sales.filter((sale) => !isHomepageExampleSale(sale));
}

/**
 * Une vente enregistrée dans le catalogue (identifiant UUID), et non une vente d'exemple : seule une
 * vente enregistrée a un favori, un dossier ou un espace de travail.
 */
export function isPersistedSale(sale: Pick<SaleIdentity, "id">): boolean {
  return isUuid(sale.id);
}
