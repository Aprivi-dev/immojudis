type SaleIdentity = {
  id: string;
  source_name?: string | null;
  dedupe_confidence?: string | null;
};

export const EXAMPLE_SALE_ID_PREFIX = "example-immojudis-";

export function isHomepageExampleSale(sale: SaleIdentity): boolean {
  return (
    sale.id.startsWith(EXAMPLE_SALE_ID_PREFIX) ||
    sale.dedupe_confidence === "demo" ||
    sale.source_name?.toLocaleLowerCase("fr-FR").includes("démonstration immojudis") === true
  );
}

export function excludeHomepageExampleSales<TSale extends SaleIdentity>(sales: TSale[]): TSale[] {
  return sales.filter((sale) => !isHomepageExampleSale(sale));
}
