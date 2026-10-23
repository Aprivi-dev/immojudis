/**
 * Default rate-limit policies for the first-party API (plan P4-02). Kept free of
 * server-only imports so tests and documentation can reference the numbers.
 */
export const RATE_LIMIT_POLICIES = {
  /** Authenticated calculations and data lookups: 30 per minute per user. */
  compute: { limit: 30, windowSeconds: 60 },
  /** Authenticated form submissions that create records or send emails: 10 per hour per user. */
  formSubmit: { limit: 10, windowSeconds: 3600 },
  /** Anonymous public routes and third-party proxies: 60 per minute per IP. */
  publicIp: { limit: 60, windowSeconds: 60 },
  /**
   * Recherche d'aperçu du catalogue (`/api/catalogue/preview`) : 180 par minute et par IP. Chaque
   * critère modifié, page tournée ou retour au premier écran d'un visiteur anonyme est un appel, et
   * plusieurs internautes partagent une même IP (box, entreprise, mobile) : 60 serait vite atteint.
   * La réponse est de toute façon servie par le CDN pour les recherches répétées.
   */
  catalogPreviewIp: { limit: 180, windowSeconds: 60 },
} as const;

/**
 * Formulaire de contact (`src/app/contact/actions.ts`), tenu en base par le limiteur partagé : 3
 * messages par quart d'heure et par adresse, 40 par heure pour tout le site (disjoncteur). Mêmes
 * chiffres que l'ancien limiteur en mémoire, qui n'avait aucun effet d'une instance serveur à l'autre.
 */
export const CONTACT_RATE_LIMITS = {
  perIp: { limit: 3, windowSeconds: 15 * 60 },
  global: { limit: 40, windowSeconds: 60 * 60 },
} as const;

/** Fenêtre des plafonds journaliers : un jour UTC (fenêtre fixe, elle repart à zéro à minuit UTC). */
export const DAILY_WINDOW_SECONDS = 86_400;

/** Message rendu quand un plafond journalier (par compte, par adresse ou global) est atteint. */
export const DAILY_LIMIT_MESSAGE = "Limite quotidienne atteinte, réessayez demain.";

/**
 * Plafonds journaliers des opérations coûteuses que l'accès Analyse ouvre (offre de lancement
 * comprise). Le quota par compte seul ne protège pas : pendant l'offre, quiconque crée 50 comptes
 * confirmés obtient 50 fois ce quota. Chaque opération a donc quatre plafonds, tous sur un jour UTC :
 *
 * - `perUser` : par compte, au-dessus d'un usage soutenu d'un investisseur (quelques dizaines de
 *   ventes étudiées par jour) ;
 * - `perIp` : par adresse (empreinte salée, voir `enforceIpRateLimit`), environ 2,5 fois le plafond
 *   d'un compte pour qu'une box ou un cabinet partagé ne soit pas gêné, mais pas 50 comptes ;
 * - `global` : disjoncteur sur tout le site, tous comptes et adresses confondus (compteur en base,
 *   atomique). Il borne la dépense même si l'abus passe par des adresses différentes. Calibré très au-dessus
 *   de l'usage d'un site en pré-lancement ; à relever dans ce fichier quand l'audience le justifie ;
 * - `launchOfferGlobal` : part de `global` que les comptes de l'offre de lancement (compte gratuit
 *   surclassé, `PlanEntitlements.launchOffer`) peuvent consommer à eux tous. Ces comptes passent par
 *   ce compteur PUIS par `global` ; les abonnés, comptes premium et administrateurs ne passent que
 *   par `global` : il leur reste donc au moins `global - launchOfferGlobal` par jour, même si
 *   l'offre est exploitée par des centaines de comptes.
 *
 * Les actualisations de données (`dataRefresh`) n'ont ici que le plafond par adresse : le plafond par
 * compte (6 par 24 h), le plafond global (`DATA_REFRESH_GLOBAL_DAILY_LIMIT`) et sa part pour l'offre de
 * lancement (`DATA_REFRESH_LAUNCH_OFFER_DAILY_LIMIT`) sont dans la fonction SQL
 * `enqueue_data_refresh_bounded`, qui décide de l'admission dans la même transaction que l'insertion.
 */
export const DAILY_OPERATION_LIMITS = {
  /** Création ou mise à jour d'un rapport enregistré : plusieurs appels à des API publiques et une écriture. */
  propertyReportCreate: { perUser: 40, perIp: 100, global: 1_000, launchOfferGlobal: 500 },
  /** Export PDF d'un rapport : peu de calcul, mais illimité par mois dans l'offre Analyse. */
  propertyReportPdf: { perUser: 60, perIp: 150, global: 2_000, launchOfferGlobal: 1_000 },
  /** Dossier PLU et risques (JSON ou PDF) : fonction jusqu'à 180 s, nombreux appels aux services de l'État. */
  landReport: { perUser: 60, perIp: 150, global: 1_500, launchOfferGlobal: 750 },
  /** Contexte environnemental d'un bien : appels aux API Géorisques, météo et géocodage. */
  environmentContext: { perUser: 300, perIp: 600, global: 4_000, launchOfferGlobal: 2_000 },
  /**
   * Export CSV des ventes (500 lignes avec adresse, plafonné en plus par `SALES_CSV_EXPORT_DAILY_ROWS`) :
   * un investisseur en fait quelques-uns par jour ; au-delà, c'est une aspiration du catalogue.
   */
  salesCsvExport: { perUser: 20, perIp: 50, global: 400, launchOfferGlobal: 200 },
  /**
   * Flux API des ventes (100 lignes par appel, avec clé d'API ou session) : un script interroge le
   * flux quelques fois par heure ; 300 appels par jour et par compte laissent de la marge à un
   * développeur sans permettre une aspiration continue.
   */
  salesApiFeed: { perUser: 300, perIp: 750, global: 6_000, launchOfferGlobal: 2_000 },
  /**
   * Demande de mise en relation avec un avocat : une demande crée un dossier traité par une
   * personne. Seules les créations comptent (une demande déjà ouverte est reprise sans compter) ; 10
   * par heure (`RATE_LIMIT_POLICIES.formSubmit`) restait un plafond de 240 par jour et par compte.
   */
  lawyerReferralCreate: { perUser: 5, perIp: 15, global: 150, launchOfferGlobal: 60 },
  /** Création d'une clé d'API : donne un accès programmatique au flux ; le nombre de clés par compte est déjà limité par le plan. */
  apiKeyCreate: { perUser: 5, perIp: 15, global: 100, launchOfferGlobal: 40 },
} as const;

export type DailyOperation = keyof typeof DAILY_OPERATION_LIMITS;

/** Actualisations de données à la demande : plafond par adresse, sur un jour UTC. */
export const DATA_REFRESH_IP_DAILY_LIMIT = 30;

/**
 * Actualisations de données à la demande, tous comptes confondus, sur 24 heures glissantes. Chacune met
 * en file un travail du pipeline qui interroge un site source. Égal à la constante de la migration
 * `20261028170100_data_refresh_global_daily_limit.sql` (un test les compare). Les plafonds par compte
 * (6 par 24 h, 3 en cours) et la contre-pression globale (12 en cours) existaient déjà.
 */
export const DATA_REFRESH_GLOBAL_DAILY_LIMIT = 150;

/**
 * Part du plafond global ci-dessus que les comptes de l'offre de lancement (sans abonnement, premium
 * ni rôle administrateur) peuvent consommer à eux tous : les 50 autres demandes du jour restent aux
 * abonnés et aux administrateurs. Égale à la constante de la migration
 * `20261029110100_launch_offer_separate_global_caps.sql` (un test les compare).
 */
export const DATA_REFRESH_LAUNCH_OFFER_DAILY_LIMIT = 100;

/**
 * Lignes exportées par compte et par jour UTC (somme de ce que `sale_data_exports` a enregistré) :
 * l'export CSV contient l'adresse de chaque vente. 2 000 lignes, soit 4 exports pleins de 500.
 */
export const SALES_CSV_EXPORT_DAILY_ROWS = 2_000;

/** Même plafond pour le flux API (100 lignes par appel au plus) : 50 appels pleins par jour. */
export const SALES_API_FEED_DAILY_ROWS = 5_000;

/** Maximum number of lawyer profiles returned by one directory call. */
export const LAWYER_DIRECTORY_PAGE_SIZE = 50;

/** Edge cache lifetime of the public directory and offer responses, in seconds. */
export const PUBLIC_DIRECTORY_CACHE_SECONDS = 3600;
export const BILLING_OFFER_CACHE_SECONDS = 300;
