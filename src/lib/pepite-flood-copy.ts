/**
 * Textes du contrôle du risque d'inondation du repère « Pépite » (règle `pepite-v2`), réunis ICI pour la
 * relecture juridique : un texte change à cet endroit ou nulle part. Module sans dépendance (la pastille, les
 * cartes et la fiche l'importent dans le navigateur ; la règle `pepite-policy.ts` n'y est pas chargée).
 *
 * Rédaction validée par `juridique-rgpd` le 26/10/2026. Règles :
 *  - le repère ne dit jamais qu'un bien est « sans risque » : seules les cartes consultées parlent ;
 *  - jamais de coche pour « exposé », « aucun signal » ou « inconnu » ;
 *  - la crue fréquente n'est jamais chiffrée en public (jamais « dix ans ») ;
 *  - mots interdits partout (`FLOOD_FORBIDDEN_WORDS`, vérifiés par un test) : « hors zone inondable »,
 *    « zone non inondable », « sans risque », « sécurisé », « aucun risque d’inondation » (seule la tournure
 *    « Aucun risque d’inondation élevé identifié… » est admise), « certifié ».
 */

/** Verdicts affichables : `high` ne l'est jamais (la vente n'est pas une pépite). */
export type PepiteFloodDisplayVerdict =
  | "none_found"
  | "tri_only"
  | "exposed"
  | "no_signal"
  | "unknown";

export const FLOOD_NONE_FOUND_LINE =
  "Aucun risque d’inondation élevé identifié à la position connue du bien, d’après les cartes officielles consultées.";
export const FLOOD_NONE_FOUND_DETAIL =
  "Cartes consultées : zone inondée par une crue fréquente des territoires à risque important d’inondation (TRI) et périmètres des plans de prévention des risques d’inondation (PPRi). Ces cartes ne couvrent pas tout le territoire ni toutes les causes d’inondation. Ce n’est pas une garantie d’absence de risque.";
export const FLOOD_NO_SIGNAL_LINE =
  "Risque d’inondation non vérifié au niveau du bien : sa position n’est pas assez précise. La commune ne compte aucun territoire à risque important d’inondation (TRI), ce qui ne dit rien du risque propre au bien.";
export const FLOOD_UNKNOWN_LINE =
  "Risque d’inondation non vérifié à ce jour pour ce bien (position imprécise ou source indisponible). Le repère est conservé sans ce contrôle.";
/** Suffixe de la ligne « inconnu » quand un contrôle réussi a déjà eu lieu : « Dernier contrôle réussi : … ». */
export const FLOOD_UNKNOWN_LAST_CHECK_PREFIX = "Dernier contrôle réussi le";
/** Mention courte « exposé » : partout où le badge Pépite apparaît (fiche, cartes, carte, texte accessible). */
export const FLOOD_EXPOSED_SHORT =
  "Dans le périmètre d’un plan de prévention des risques d’inondation (PPRi) : zonage à vérifier.";
export const FLOOD_EXPOSED_LONG =
  "Ce bien se trouve dans le périmètre d’un plan de prévention des risques d’inondation (PPRi), d’après le Géoportail de l’urbanisme. Ce périmètre ne dit pas dans quelle zone du plan (rouge, bleue ou autre) se situe le bien, ni quelles règles s’y appliquent. Vérifiez-le dans l’état des risques et les diagnostics annexés au cahier des conditions de vente (demandez-les à l’avocat poursuivant s’ils manquent), et auprès de la mairie.";
/**
 * « Aucun risque élevé identifié » qui ne repose que sur les TRI : les périmètres de PPRi n'ont pas pu être lus.
 * Ligne neutre, sans coche et sans la phrase sur les périmètres de PPRi.
 */
export const FLOOD_TRI_ONLY_LINE =
  "Zone de crue fréquente des TRI consultée ; périmètres de PPRi non contrôlés à ce jour.";
/** Mise en garde sous le bloc Pépite de la fiche, quand un contrôle d'inondation y figure. */
export const FLOOD_WARNING =
  "Contrôle automatique d’après des cartes officielles, sans valeur d’expertise. Ce n’est ni un état des risques, ni un certificat : il ne garantit pas l’absence de risque d’inondation et ne remplace pas l’état des risques annexé au cahier des conditions de vente.";

export const FLOOD_TRI_SOURCE_URL = "https://www.georisques.gouv.fr/";
export const FLOOD_PM1_SOURCE_URL = "https://www.geoportail-urbanisme.gouv.fr/";

/** « Source : Géorisques …, scénario de crue fréquente ; consulté le [date] ». */
export function floodTriSourceLine(checkedOn: string | null): string {
  return `Source : Géorisques (ministère de la Transition écologique, BRGM), cartographie des territoires à risque important d’inondation (TRI), scénario de crue fréquente${checkedOn ? ` ; consulté le ${checkedOn}` : ""}.`;
}

/** « Source : Géoportail de l’urbanisme …, servitude PM1 ; consulté le [date] ». */
export function floodPm1SourceLine(checkedOn: string | null): string {
  return `Source : Géoportail de l’urbanisme (IGN), servitude d’utilité publique PM1, via l’API Carto de l’IGN${checkedOn ? ` ; consulté le ${checkedOn}` : ""}.`;
}

/**
 * Mots et tournures qu'aucun texte du contrôle d'inondation ne doit contenir (test : `pepite-flood-copy.test.ts`).
 * « aucun risque d’inondation » n'est refusé que seul : « Aucun risque d’inondation élevé identifié… » est la
 * tournure validée.
 */
export const FLOOD_FORBIDDEN_WORDS: readonly RegExp[] = [
  /hors zone inondable/i,
  /zone non inondable/i,
  /sans risque/i,
  /sécurisé/i,
  /aucun risque d[’']inondation(?! élevé)/i,
  /certifié/i,
  /dix ans/i,
  /10 ans/i,
];

/** Texte accessible ajouté à la pastille ou à la carte d'une pépite dans le périmètre d'un PPRi. */
export const FLOOD_EXPOSED_ACCESSIBLE_LABEL = `Pépite. ${FLOOD_EXPOSED_SHORT}`;
