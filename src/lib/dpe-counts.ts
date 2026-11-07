import { DPE_CLASSES } from "@/lib/dpe";
import type { DpeClass } from "@/lib/dpe";

export function emptyDpeCounts(): Record<DpeClass, number> {
  return DPE_CLASSES.reduce(
    (acc, dpeClass) => {
      acc[dpeClass] = 0;
      return acc;
    },
    {} as Record<DpeClass, number>,
  );
}
