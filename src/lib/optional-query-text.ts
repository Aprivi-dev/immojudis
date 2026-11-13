import { z } from "zod";

/** Paramètre texte facultatif d'une requête d'API : vide ou blanc vaut absent ; coupé et borné à `max`. */
export const optionalQueryText = (max = 140) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(max).optional(),
  );
