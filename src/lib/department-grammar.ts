import type { DepartmentRef } from "@/lib/department-pages";

/**
 * Le département dans une phrase : « en Gironde », « à Paris », « dans le Nord », « dans la Loire », « dans les
 * Bouches-du-Rhône ». La préposition dépend du genre et du nombre du nom, qu'aucune règle ne
 * devine : une table par code (les noms viennent de `FEES_SIMULATOR_DEPARTMENTS`, un test vérifie
 * que chaque département y figure).
 */
type Locative = "en" | "à" | "le" | "la" | "l" | "les";

const LOCATIVE_BY_CODE: Readonly<Record<string, Locative>> = {
  "01": "l", // Ain
  "02": "l", // Aisne
  "03": "l", // Allier
  "04": "les", // Alpes-de-Haute-Provence
  "05": "les", // Hautes-Alpes
  "06": "les", // Alpes-Maritimes
  "07": "en", // Ardèche
  "08": "les", // Ardennes
  "09": "en", // Ariège
  "10": "l", // Aube
  "11": "l", // Aude
  "12": "l", // Aveyron
  "13": "les", // Bouches-du-Rhône
  "14": "le", // Calvados
  "15": "le", // Cantal
  "16": "en", // Charente
  "17": "en", // Charente-Maritime
  "18": "le", // Cher
  "19": "en", // Corrèze
  "2A": "en", // Corse-du-Sud
  "2B": "en", // Haute-Corse
  "21": "en", // Côte-d'Or
  "22": "les", // Côtes-d'Armor
  "23": "en", // Creuse
  "24": "en", // Dordogne
  "25": "le", // Doubs
  "26": "la", // Drôme
  "27": "l", // Eure
  "28": "l", // Eure-et-Loir
  "29": "le", // Finistère
  "30": "le", // Gard
  "31": "en", // Haute-Garonne
  "32": "le", // Gers
  "33": "en", // Gironde
  "34": "l", // Hérault
  "35": "en", // Ille-et-Vilaine
  "36": "l", // Indre
  "37": "l", // Indre-et-Loire
  "38": "en", // Isère
  "39": "le", // Jura
  "40": "les", // Landes
  "41": "le", // Loir-et-Cher
  "42": "la", // Loire
  "43": "en", // Haute-Loire
  "44": "en", // Loire-Atlantique
  "45": "le", // Loiret
  "46": "le", // Lot
  "47": "le", // Lot-et-Garonne
  "48": "en", // Lozère
  "49": "le", // Maine-et-Loire
  "50": "la", // Manche
  "51": "la", // Marne
  "52": "en", // Haute-Marne
  "53": "la", // Mayenne
  "54": "en", // Meurthe-et-Moselle
  "55": "la", // Meuse
  "56": "le", // Morbihan
  "57": "la", // Moselle
  "58": "la", // Nièvre
  "59": "le", // Nord
  "60": "l", // Oise
  "61": "l", // Orne
  "62": "le", // Pas-de-Calais
  "63": "le", // Puy-de-Dôme
  "64": "les", // Pyrénées-Atlantiques
  "65": "les", // Hautes-Pyrénées
  "66": "les", // Pyrénées-Orientales
  "67": "le", // Bas-Rhin
  "68": "le", // Haut-Rhin
  "69": "le", // Rhône
  "70": "en", // Haute-Saône
  "71": "en", // Saône-et-Loire
  "72": "la", // Sarthe
  "73": "en", // Savoie
  "74": "en", // Haute-Savoie
  "75": "à", // Paris
  "76": "en", // Seine-Maritime
  "77": "en", // Seine-et-Marne
  "78": "les", // Yvelines
  "79": "les", // Deux-Sèvres
  "80": "la", // Somme
  "81": "le", // Tarn
  "82": "le", // Tarn-et-Garonne
  "83": "le", // Var
  "84": "le", // Vaucluse
  "85": "en", // Vendée
  "86": "la", // Vienne
  "87": "en", // Haute-Vienne
  "88": "les", // Vosges
  "89": "l", // Yonne
  "90": "le", // Territoire de Belfort
  "91": "en", // Essonne
  "92": "les", // Hauts-de-Seine
  "93": "en", // Seine-Saint-Denis
  "94": "le", // Val-de-Marne
  "95": "le", // Val-d'Oise
  "971": "en", // Guadeloupe
  "972": "en", // Martinique
  "973": "en", // Guyane
  "974": "à", // La Réunion
  "976": "à", // Mayotte
};

type DepartmentName = Pick<DepartmentRef, "code" | "name">;

/** « en Gironde », « à Paris », « dans le Nord », « dans la Loire », « dans l’Ain », « dans les Landes ». */
export function departmentIn({ code, name }: DepartmentName): string {
  switch (LOCATIVE_BY_CODE[code]) {
    case "en":
      return `en ${name}`;
    case "à":
      return `à ${name}`;
    case "le":
      return `dans le ${name}`;
    case "la":
      return `dans la ${name}`;
    case "l":
      return `dans l’${name}`;
    case "les":
      return `dans les ${name}`;
    default:
      // Département hors de la table : un libellé neutre plutôt qu'une préposition devinée.
      return `dans le département ${name}`;
  }
}
