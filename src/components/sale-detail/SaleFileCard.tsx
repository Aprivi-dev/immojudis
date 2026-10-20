"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import FolderHeart from "lucide-react/dist/esm/icons/folder-heart.js";
import { FavoriteButton } from "@/components/FavoriteButton";
import { SaleRemindersToggle } from "@/components/SaleRemindersToggle";
import { Button, Card, Eyebrow } from "@/components/ui/primitives";
import { useAuth } from "@/hooks/use-auth";
import { fetchFavoriteDossier, saveFavoriteDossier } from "@/lib/client-api";
import {
  FAVORITE_DOSSIER_STATUSES,
  favoriteDossierStatusLabel,
  formatBidCeilingInput,
  normalizeFavoriteDossierStatus,
  parseBidCeilingInput,
  type FavoriteDossierInput,
  type FavoriteDossierResponse,
} from "@/lib/favorite-dossier-shared";
import { formatDate, formatPrice } from "@/lib/format";
import { queryKeys } from "@/lib/query-keys";
import { toast } from "@/lib/toast";
import { userMessage } from "@/lib/user-messages";

/**
 * « Mon dossier » (point 68), gratuit : le statut personnel et l'enchère plafond d'une vente suivie,
 * enregistrés sur le compte et retrouvés dans « Mes favoris ». Le stockage est gratuit ; le calcul
 * de l'enchère plafond garde ses droits (Analyse, ou la vente débloquée) : `calculatedCeiling` est
 * le résultat du calculateur de la fiche, absent quand le compte n'y a pas accès.
 */
export function SaleFileCard({
  saleId,
  calculatedCeiling,
  calculationPending = false,
  onOpenWorkspace,
}: {
  saleId: string;
  /** Enchère plafond calculée par le calculateur de la fiche, en euros ; null si elle n'est pas disponible. */
  calculatedCeiling: number | null;
  /** Le calcul est ouvert à ce compte mais l'estimation de marché n'est pas encore arrivée. */
  calculationPending?: boolean;
  /**
   * Compte Analyse : ouvre le dialogue du dossier de travail. « Mon dossier » en est l'unique porte
   * d'entrée ; absent pour les autres comptes (le bouton n'apparaît pas).
   */
  onOpenWorkspace?: () => void;
}) {
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();
  const statusId = useId();
  const ceilingId = useId();
  const ceilingHelpId = `${ceilingId}-help`;
  const ceilingErrorId = `${ceilingId}-error`;
  const ceilingInputRef = useRef<HTMLInputElement>(null);
  const userId = user?.id ?? null;
  const dossierKey = queryKeys.favoriteDossier(userId, saleId);
  /** Texte saisi dans le champ du plafond ; `null` tant qu'on n'y a pas touché (le plafond enregistré s'affiche). */
  const [ceilingDraft, setCeilingDraft] = useState<string | null>(null);
  const [ceilingError, setCeilingError] = useState<string | null>(null);
  // Régions vivantes : montées avec le formulaire et vides, elles annoncent ensuite l'enregistrement.
  const [statusMessage, setStatusMessage] = useState("");
  const [ceilingMessage, setCeilingMessage] = useState("");

  const query = useQuery({
    queryKey: dossierKey,
    queryFn: () => fetchFavoriteDossier(saleId),
    enabled: Boolean(userId) && !loading,
  });
  const save = useMutation({
    mutationFn: (changes: Omit<FavoriteDossierInput, "saleId">) =>
      saveFavoriteDossier({ data: { saleId, ...changes } }),
    onMutate: (changes) => {
      if (changes.personalStatus !== undefined) setStatusMessage("");
      if (changes.bidCeilingEur !== undefined) setCeilingMessage("");
    },
    onSuccess: (response: FavoriteDossierResponse, changes) => {
      queryClient.setQueryData(dossierKey, response);
      // La liste « Mes favoris » (clé exacte) : la réponse du serveur vient déjà d'être posée sur ce dossier.
      void queryClient.invalidateQueries({ queryKey: queryKeys.favorites(userId), exact: true });
      // Le retour est dit dans la région vivante de la zone modifiée (une seule annonce, pas de toast).
      if (changes.personalStatus !== undefined) {
        setStatusMessage(changes.personalStatus ? "Statut enregistré" : "Statut retiré");
      }
      if (changes.bidCeilingEur !== undefined) {
        setCeilingDraft(null);
        setCeilingError(null);
        setCeilingMessage(
          changes.bidCeilingEur != null ? "Enchère plafond enregistrée" : "Enchère plafond retirée",
        );
      }
    },
    onError: (error: unknown) =>
      toast.error(userMessage(error, "Impossible d’enregistrer votre dossier.")),
  });

  // `/sales/<id>#mon-dossier` (« Mon démarrage ») : la carte se charge à la demande, après la
  // navigation ; le navigateur n'a donc pas trouvé l'ancre. On y défile une fois la carte affichée.
  const showsCard = Boolean(userId) && !loading;
  useEffect(() => {
    if (!showsCard || window.location.hash !== "#mon-dossier") return;
    document.getElementById("mon-dossier")?.scrollIntoView?.({ block: "start" });
  }, [showsCard]);

  if (!userId || loading) return null;

  const dossier = query.data?.dossier;
  // Un plafond de 0 € n'existe pas : une ancienne valeur nulle compte comme absente.
  const savedCeiling =
    dossier?.bidCeilingEur != null && dossier.bidCeilingEur > 0 ? dossier.bidCeilingEur : null;
  const calculated =
    calculatedCeiling != null && Number.isFinite(calculatedCeiling) && calculatedCeiling >= 0
      ? Math.round(calculatedCeiling)
      : null;
  // Un calcul qui arrondit à 0 € ne se propose pas : il n'y a aucune enchère à reprendre.
  const ceiling = calculated != null && calculated >= 1 ? calculated : null;
  const ceilingValue =
    ceilingDraft ?? (savedCeiling != null ? formatBidCeilingInput(savedCeiling) : "");

  function fillCalculatedCeiling() {
    if (ceiling == null) return;
    setCeilingDraft(formatBidCeilingInput(ceiling));
    setCeilingError(null);
    ceilingInputRef.current?.focus();
  }

  function submitCeiling(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (save.isPending) return;
    const parsed = parseBidCeilingInput(ceilingValue);
    if (!parsed.ok) {
      setCeilingError(parsed.message);
      ceilingInputRef.current?.focus();
      return;
    }
    setCeilingError(null);
    save.mutate({ bidCeilingEur: parsed.value });
  }

  return (
    <Card as="section" aria-labelledby="sale-file-title" className="mt-4" id="mon-dossier">
      <Eyebrow className="flex items-center gap-2">
        <FolderHeart className="size-4" aria-hidden /> Gratuit, sur votre compte
      </Eyebrow>
      <h2 id="sale-file-title" className="mt-2 font-display text-2xl text-brand-navy">
        Mon dossier
      </h2>

      {query.isPending ? (
        <p role="status" className="mt-2 text-sm text-ink-soft">
          Chargement de votre dossier…
        </p>
      ) : query.isError ? (
        <div role="alert" className="mt-2 text-sm">
          <p>{userMessage(query.error, "Votre dossier est momentanément indisponible.")}</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={() => void query.refetch()}
          >
            Réessayer
          </Button>
        </div>
      ) : dossier && !dossier.followed ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-xl text-sm leading-relaxed text-ink-soft">
            Le suivi conditionne l’enregistrement : suivez cette vente (le cœur) pour y noter votre
            statut et votre enchère plafond. Sans suivi, rien n’est conservé. Vous les retrouverez
            ensuite dans vos favoris, sur tous vos appareils.
          </p>
          <FavoriteButton saleId={saleId} />
        </div>
      ) : dossier ? (
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={statusId} className="text-sm font-semibold text-brand-navy">
              Mon statut
            </label>
            <select
              id={statusId}
              className="form-input mt-1 min-h-11 w-full"
              value={dossier.personalStatus ?? ""}
              // `aria-busy` plutôt que `disabled` : un champ désactivé fait perdre le focus au clavier.
              aria-busy={save.isPending}
              onChange={(event) => {
                if (save.isPending) return;
                save.mutate({ personalStatus: normalizeFavoriteDossierStatus(event.target.value) });
              }}
            >
              <option value="">Aucun statut</option>
              {FAVORITE_DOSSIER_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {favoriteDossierStatusLabel(status)}
                </option>
              ))}
            </select>
            <p role="status" className="mt-1 min-h-4 text-xs font-semibold text-ink-soft">
              {statusMessage}
            </p>
          </div>

          <div>
            <label htmlFor={ceilingId} className="text-sm font-semibold text-brand-navy">
              Mon enchère plafond
            </label>
            <p className="mt-1 text-sm" data-testid="saved-ceiling">
              {savedCeiling != null ? (
                <>
                  <strong className="tabular-nums">{formatPrice(savedCeiling)}</strong>
                  {dossier.bidCeilingSavedAt
                    ? ` · enregistrée le ${formatDate(dossier.bidCeilingSavedAt)}`
                    : null}
                </>
              ) : (
                "Aucune enchère plafond enregistrée."
              )}
            </p>
            <form onSubmit={submitCeiling} noValidate className="mt-2" aria-busy={save.isPending}>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <input
                    ref={ceilingInputRef}
                    id={ceilingId}
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="Ex. 185 000"
                    value={ceilingValue}
                    onChange={(event) => {
                      setCeilingDraft(event.target.value);
                      setCeilingError(null);
                    }}
                    onBlur={() => {
                      // Séparateurs français une fois la saisie terminée : « 185000 » devient « 185 000 ».
                      const parsed = parseBidCeilingInput(ceilingValue);
                      if (ceilingDraft !== null && parsed.ok) {
                        setCeilingDraft(formatBidCeilingInput(parsed.value));
                      }
                    }}
                    aria-invalid={ceilingError ? true : undefined}
                    aria-describedby={`${ceilingHelpId}${ceilingError ? ` ${ceilingErrorId}` : ""}`}
                    className="form-input min-h-11 w-full min-w-0 tabular-nums"
                  />
                  <span aria-hidden className="shrink-0 text-sm text-ink-soft">
                    €
                  </span>
                </div>
                <Button
                  type="submit"
                  variant="primary"
                  aria-disabled={save.isPending || undefined}
                  className="aria-disabled:cursor-wait aria-disabled:opacity-60"
                >
                  Enregistrer
                </Button>
              </div>
              <p id={ceilingHelpId} className="mt-1 text-xs leading-relaxed text-ink-soft">
                Montant en euros, par exemple 185 000.
              </p>
              {ceilingError ? (
                <p
                  id={ceilingErrorId}
                  role="alert"
                  className="mt-1 text-xs font-semibold text-red-700"
                >
                  {ceilingError}
                </p>
              ) : null}
            </form>
            {ceiling == null && calculationPending ? (
              <p role="status" className="mt-2 text-xs leading-relaxed text-ink-soft">
                Calcul de l’enchère plafond en cours…
              </p>
            ) : ceiling == null && calculated == null ? (
              <p className="mt-2 text-xs leading-relaxed text-ink-soft">
                Aucun calcul d’enchère plafond n’est disponible pour cette vente avec votre accès
                actuel : saisissez votre propre montant si vous en avez un.
              </p>
            ) : ceiling == null ? (
              <p className="mt-2 text-xs leading-relaxed text-ink-soft">
                Le calcul actuel ne laisse aucune marge d’enchère : saisissez votre propre montant
                si vous en avez un.
              </p>
            ) : ceiling === savedCeiling ? (
              <p className="mt-2 text-xs leading-relaxed text-ink-soft">
                C’est le résultat du calcul actuel.
              </p>
            ) : (
              <div className="mt-2">
                {savedCeiling != null ? (
                  <p className="mb-2 text-xs leading-relaxed text-ink-soft">
                    Le calcul actuel donne {formatPrice(ceiling)} : votre plafond enregistré ne
                    change que si vous l’enregistrez.
                  </p>
                ) : null}
                <Button variant="secondary" size="sm" onClick={fillCalculatedCeiling}>
                  Utiliser le calcul : {formatPrice(ceiling)}
                </Button>
              </div>
            )}
            {savedCeiling != null ? (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 aria-disabled:cursor-wait aria-disabled:opacity-60"
                aria-disabled={save.isPending || undefined}
                onClick={() => {
                  if (save.isPending) return;
                  setCeilingError(null);
                  save.mutate({ bidCeilingEur: null });
                }}
              >
                Retirer mon plafond
              </Button>
            ) : null}
            <p role="status" className="mt-1 min-h-4 text-xs font-semibold text-ink-soft">
              {ceilingMessage}
            </p>
          </div>
        </div>
      ) : null}

      {onOpenWorkspace ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <p className="max-w-xl text-sm leading-relaxed text-ink-soft">
            Offre Analyse : pièces, budget, vérifications et prochaine action de cette vente. Votre
            statut et votre enchère plafond restent ceux de « Mon dossier » : le dossier de travail
            les reprend sans les modifier.
          </p>
          <Button variant="secondary" onClick={onOpenWorkspace}>
            Ouvrir le dossier de travail
          </Button>
        </div>
      ) : null}

      {dossier?.followed ? (
        <>
          <SaleRemindersToggle
            userId={userId}
            className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-4 py-3 text-sm"
          />
          <p className="mt-4 text-xs leading-relaxed text-ink-soft">
            Ce dossier est attaché au suivi de la vente : retirer la vente de vos favoris l’efface.
            Une confirmation vous est demandée avant.
          </p>
        </>
      ) : null}

      <p className="mt-4 text-xs leading-relaxed text-ink-soft">
        L’enchère plafond est une simulation fondée sur vos hypothèses : elle ne garantit aucun prix
        d’adjudication et ne remplace pas le conseil de votre avocat.
      </p>
    </Card>
  );
}
