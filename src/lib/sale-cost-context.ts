import { classifyOccupancy, type OccupancyKind } from "@/lib/profitability";

/**
 * Facts about a sale that change the acquisition cost and the bid ceiling:
 * the département sets the registration duties, the occupation sets the
 * discount and the carrying months. Every caller that computes a ceiling must
 * derive them from the sale the same way so the page, the API and a saved
 * report agree.
 */
export function saleCostContext(sale: {
  department?: string | null;
  occupancy_status?: string | null;
}): { department: string | null; occupancy: OccupancyKind } {
  return {
    department: sale.department ?? null,
    occupancy: classifyOccupancy(sale.occupancy_status),
  };
}
