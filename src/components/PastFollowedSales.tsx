"use client";

import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import CalendarPlus from "lucide-react/dist/esm/icons/calendar-plus.js";
import { Terme } from "@/components/ceiling/Terme";
import { Badge, Button, Card } from "@/components/ui/primitives";
import { useAuth } from "@/hooks/use-auth";
import {
  deleteFollowedSaleSnapshot,
  downloadSnapshotDeadlines,
  fetchFollowedSaleSnapshots,
  updateFollowedSaleSnapshot,
} from "@/lib/client-api";
import {
  FAVORITE_DOSSIER_STATUSES,
  favoriteDossierStatusLabel,
  formatBidCeilingInput,
  normalizeFavoriteDossierStatus,
} from "@/lib/favorite-dossier-shared";
import { formatDate, formatPrice, propertyTypeLabel } from "@/lib/format";
import type {
  FollowedSaleSnapshot,
  FollowedSaleSnapshotResult,
} from "@/lib/followed-sale-snapshots-shared";
import { tribunalBarAssociation } from "@/lib/lawyer-bar";
import * as queryKeys from "@/lib/query-keys";
import { DEADLINES_CONFIRM_NOTICE, saleDeadlines } from "@/lib/sale-deadlines";
import {
  buildSnapshotBalance,
  gapWithCeiling,
  parseFinalPriceInput,
  statusAllowsFinalPrice,
  type BalanceGroup,
  type CeilingGap,
} from "@/lib/snapshot-balance";
import type { SurenchereWindow } from "@/lib/surenchere-window";
import { toast } from "@/lib/toast";
import { userMessage } from "@/lib/user-messages";

/**
 * « Ventes passées » (point 70) : pour chaque vente suivie dont l'audience est passée, l'instantané
 * gardé dans l'espace du compte quand le catalogue a retiré la vente. Rien n'est affiché tant qu'il
 * n'y en a aucun. Une valeur absente s'affiche comme absente : aucun prix n'est déduit.
 */
export function PastFollowedSales() {
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id ?? null;
  const key = queryKeys.followedSaleSnapshots(userId);
  const query = useQuery({
    queryKey: key,
    queryFn: fetchFollowedSaleSnapshots,
    enabled: Boolean(userId) && !loading,
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteFollowedSaleSnapshot({ id }),
    onSuccess: () => {
      toast.success("Vente retirée de votre espace.");
      return queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error: unknown) =>
      toast.error(userMessage(error, "Impossible de retirer cette vente.")),
  });

  if (!userId || loading || query.isPending) return null;
  if (query.isError) {
    return (
      <section className="mt-10" aria-labelledby="past-sales-title">
        <h2 id="past-sales-title" className="font-display text-2xl font-semibold">
          Ventes passées
        </h2>
        <p role="alert" className="mt-2 text-sm text-ink-soft">
          {userMessage(query.error, "Vos ventes passées sont momentanément indisponibles.")}
        </p>
      </section>
    );
  }
  const snapshots = query.data?.snapshots ?? [];
  if (snapshots.length === 0) return null;

  return (
    <section className="mt-10" aria-labelledby="past-sales-title">
      <h2 id="past-sales-title" className="font-display text-2xl font-semibold">
        Ventes passées
      </h2>
      <p className="mt-1 text-sm text-ink-soft">
        Les ventes que vous suiviez, dont l’audience est passée. Immojudis en garde ici un résumé
        pendant 6 mois au plus, puis l’efface ; vous pouvez le retirer à tout moment.
      </p>
      <BalanceSummary snapshots={snapshots} />
      <ul className="mt-4 grid gap-4 lg:grid-cols-2">
        {snapshots.map((snapshot) => (
          <li key={snapshot.id} className="min-w-0">
            <SnapshotCard
              snapshot={snapshot}
              busy={remove.isPending && remove.variables === snapshot.id}
              onRemove={() => {
                // Le résumé est supprimé pour de bon : on demande confirmation avant.
                if (
                  window.confirm(
                    "Retirer cette vente de votre espace ? Le résumé conservé sera supprimé et ne pourra pas être rétabli.",
                  )
                ) {
                  remove.mutate(snapshot.id);
                }
              }}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function SnapshotCard({
  snapshot,
  busy,
  onRemove,
}: {
  snapshot: FollowedSaleSnapshot;
  busy: boolean;
  onRemove: () => void;
}) {
  const place = [
    snapshot.city,
    snapshot.department ? `(${snapshot.department})` : null,
    snapshot.propertyType ? `· ${propertyTypeLabel(snapshot.propertyType)}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Card as="article" className="h-full">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="font-display text-xl text-brand-navy">
          {snapshot.title ?? "Vente sans titre"}
        </h3>
        <Badge tone="neutral">Audience passée</Badge>
      </div>
      {place ? <p className="mt-1 text-sm text-ink-soft">{place}</p> : null}
      <dl className="mt-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
        <Fact
          label="Audience"
          value={snapshot.saleDate ? formatDate(snapshot.saleDate) : "Date non connue"}
        />
        <Fact label="Tribunal" value={snapshot.tribunalName ?? "Non renseigné"} />
        <Fact label="Mise à prix" value={formatPrice(snapshot.startingPriceEur)} />
        <Fact label="Avocat" value={snapshot.lawyerName ?? "Non renseigné"} />
        <Fact
          label="Mon plafond"
          value={
            snapshot.bidCeilingEur != null
              ? formatPrice(snapshot.bidCeilingEur)
              : "Aucun enregistré"
          }
        />
      </dl>

      <div className="mt-3 rounded-lg border border-line bg-surface-tint p-3 text-sm">
        <p className="font-semibold text-brand-navy">
          Résultat de l’<Terme terme="adjudication">adjudication</Terme>
        </p>
        <p className="mt-1" data-testid="snapshot-result">
          {resultText(snapshot.result)}
        </p>
      </div>

      <SurenchereBlock info={snapshot.surenchere} tribunalName={snapshot.tribunalName} />

      <PersonalResult snapshot={snapshot} />
      {snapshot.personalStatus === "won" ? <DeadlinesBlock snapshot={snapshot} /> : null}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-soft">
        <span>Gardé jusqu’au {formatDate(snapshot.expiresAt)}</span>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onRemove}>
          Retirer de mon espace
        </Button>
      </div>
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1">
      <dt className="font-semibold text-brand-navy">{label} :</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** Le résultat tel que la base l'a gardé : aucune valeur n'est déduite ni estimée. */
export function resultText(result: FollowedSaleSnapshotResult): string {
  if (result.priceEur != null) {
    return `Adjugé à ${formatPrice(result.priceEur)}${
      result.priceSource ? ` (source : ${result.priceSource})` : ""
    }.`;
  }
  if (result.priceWithheld) {
    return "Adjugé. Le prix d’adjudication est réservé à l’offre Analyse.";
  }
  if (result.status === "adjudicated") return "Adjugé. Prix d’adjudication non connu.";
  return "Résultat non connu.";
}

/**
 * Surenchère : formulation prudente (texte de la relecture juridique du 20/10/2026, à faire valider
 * par un avocat). La date est indicative (dix jours après l'audience connue d'Immojudis) ; le report
 * au premier jour ouvrable n'est pas calculé, le texte le dit et demande de ne pas compter dessus.
 * Jamais « fenêtre échue », « il reste N jours » ni « dernier jour » : une fois la date passée, le
 * délai a pu expirer ou être prolongé, et la personne concernée est renvoyée sans attendre à un
 * avocat. Les mêmes phrases sont dans `surenchereLines` (`sale-result-emails.ts`) ; un test vérifie
 * qu'elles restent identiques. Le lien de l'annuaire est filtré sur le barreau du tribunal quand
 * son nom le permet (`?bar=`), sinon il mène à l'annuaire entier.
 */
function SurenchereBlock({
  info,
  tribunalName,
}: {
  info: SurenchereWindow;
  tribunalName: string | null;
}) {
  const bar = tribunalBarAssociation(tribunalName);
  const directoryHref = bar ? `/avocats?bar=${encodeURIComponent(bar)}` : "/avocats";
  return (
    <div className="mt-3 text-sm" data-testid="snapshot-surenchere">
      <p className="font-semibold text-brand-navy">
        Fenêtre de <Terme terme="surenchere">surenchère</Terme>
      </p>
      {info.kind === "window" ? (
        <>
          <p className="mt-1">
            {info.adjudicationConfirmed
              ? null
              : "Le résultat n’est pas connu : la surenchère n’existe que si le bien a été adjugé. "}
            Date indicative : le {formatDate(info.deadline)}. Si ce jour tombe un samedi, un
            dimanche ou un jour férié, le délai peut être prolongé jusqu’au premier jour ouvrable
            suivant ; ne comptez pas dessus sans l’avis d’un avocat. Elle est calculée à partir de
            la date d’audience connue d’Immojudis, qui peut avoir changé.
          </p>
          {info.expired ? (
            <p className="mt-1 font-semibold text-brand-navy">
              Cette date indicative est passée : le délai a pu expirer, ou être prolongé. Si vous
              êtes concerné, consultez sans attendre un avocat, seul à pouvoir le confirmer.
            </p>
          ) : null}
          <p className="mt-1 text-ink-soft">
            La surenchère se forme par acte d’avocat déposé au greffe du juge de l’exécution, avec
            une garantie d’un dixième du prix principal (chèque de banque ou caution bancaire
            irrévocable, art. R. 322-51 du CPCE). Faites confirmer la date et les conditions par un
            avocat, de préférence inscrit au barreau du tribunal concerné ; le choix vous appartient
            (
            <Link href={directoryHref} className="font-semibold text-gold-text underline">
              l’annuaire d’Immojudis
            </Link>{" "}
            signale les profils mis en avant contre rémunération).
          </p>
        </>
      ) : info.kind === "no_date" ? (
        <p className="mt-1 text-ink-soft">
          La date d’audience n’est pas connue : la date indicative ne peut pas être calculée.
          Interrogez un avocat de votre choix.
        </p>
      ) : (
        <p className="mt-1 text-ink-soft">
          Non déterminée pour ce type de vente. Vérifiez le cahier des charges avec l’avocat ou le
          notaire.
        </p>
      )}
    </div>
  );
}

/** « 12 000 € de plus que votre plafond (+7 %) », « 5 000 € de moins… » ou « égal à votre plafond ». */
export function gapText(gap: CeilingGap): string {
  if (gap.eur === 0) return "égal à votre plafond";
  const amount = formatPrice(Math.abs(gap.eur));
  const pct = `${gap.pct > 0 ? "+" : gap.pct < 0 ? "−" : ""}${Math.abs(gap.pct)} %`;
  return `${amount} de ${gap.eur > 0 ? "plus" : "moins"} que votre plafond (${pct})`;
}

/** « 7 % au-dessus de votre plafond », « 3 % en dessous… » ou « égal à votre plafond ». */
export function averageGapText(pct: number): string {
  if (pct === 0) return "égal à votre plafond";
  return `${Math.abs(pct)} % ${pct > 0 ? "au-dessus de" : "en dessous de"} votre plafond`;
}

/**
 * Bilan après adjudication (n° 94) : de petits chiffres tirés de ce que la personne a elle-même noté
 * (statut, enchère plafond, prix final) sur ses ventes passées encore conservées. Ni prévision ni
 * comparaison avec d'autres comptes ; rien n'est affiché tant qu'aucune vente n'est marquée
 * « Remporté » ou « Non remporté ».
 */
function BalanceSummary({ snapshots }: { snapshots: readonly FollowedSaleSnapshot[] }) {
  const balance = buildSnapshotBalance(snapshots);
  if (balance.won.count + balance.lost.count === 0) return null;
  const line = (label: string, group: BalanceGroup) =>
    group.count === 0 ? null : (
      <li>
        <span className="font-semibold text-brand-navy">{label} :</span> {group.count}
        {group.averageGapPct != null
          ? ` · prix final en moyenne ${averageGapText(group.averageGapPct)}, sur ${group.compared} vente${
              group.compared > 1 ? "s" : ""
            } avec prix final et plafond`
          : " · aucun prix final noté avec un plafond : pas d’écart à calculer"}
        {group.aboveCeiling > 0 ? ` (${group.aboveCeiling} au-dessus de votre plafond)` : null}.
      </li>
    );
  return (
    <div
      className="mt-4 rounded-lg border border-line bg-surface-tint p-3 text-sm"
      data-testid="snapshot-balance"
    >
      <h3 className="font-semibold text-brand-navy">Mon bilan</h3>
      <ul className="mt-1 grid gap-1">
        {line("Ventes remportées", balance.won)}
        {line("Ventes non remportées", balance.lost)}
      </ul>
      <p className="mt-2 text-xs text-ink-soft">
        Calculé à partir de ce que vous avez noté (statut, enchère plafond, prix final) sur vos
        ventes passées encore conservées. Ce n’est pas une prévision et cela ne dit rien du prix à
        proposer pour une autre vente.
      </p>
    </div>
  );
}

/**
 * « Mon résultat » : le statut de la personne et, pour « Remporté » ou « Non remporté », le prix
 * final de l'adjudication, facultatif. Stocké sur son compte seulement (jamais envoyé par email),
 * conservé aussi longtemps que l'instantané. L'écart avec son plafond n'apparaît que si les deux
 * valeurs sont notées.
 */
function PersonalResult({ snapshot }: { snapshot: FollowedSaleSnapshot }) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const statusId = useId();
  const priceId = useId();
  const priceErrorId = `${priceId}-error`;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = queryKeys.followedSaleSnapshots(user?.id ?? null);
  const save = useMutation({
    mutationFn: (changes: {
      personalStatus?: FollowedSaleSnapshot["personalStatus"];
      finalPriceEur?: number | null;
    }) => updateFollowedSaleSnapshot({ data: { id: snapshot.id, ...changes } }),
    onSuccess: () => {
      setDraft(null);
      setError(null);
      toast.success("Votre résultat est enregistré.");
      return queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (failure: unknown) =>
      toast.error(userMessage(failure, "Impossible d’enregistrer votre résultat.")),
  });

  const withPrice = statusAllowsFinalPrice(snapshot.personalStatus);
  const value =
    draft ?? (snapshot.finalPriceEur != null ? formatBidCeilingInput(snapshot.finalPriceEur) : "");
  const gap = gapWithCeiling(snapshot.finalPriceEur, snapshot.bidCeilingEur);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (save.isPending) return;
    const parsed = parseFinalPriceInput(value);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setError(null);
    save.mutate({ finalPriceEur: parsed.value });
  }

  return (
    <div className="mt-3 text-sm" data-testid="snapshot-personal-result">
      <label htmlFor={statusId} className="font-semibold text-brand-navy">
        Mon résultat
      </label>
      <select
        id={statusId}
        className="form-input mt-1 min-h-11 w-full"
        value={snapshot.personalStatus ?? ""}
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

      {withPrice ? (
        <form onSubmit={submit} noValidate className="mt-2" aria-busy={save.isPending}>
          <label htmlFor={priceId} className="font-semibold text-brand-navy">
            Prix final de l’adjudication (facultatif)
          </label>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <input
                id={priceId}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                placeholder="Ex. 185 000"
                value={value}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setError(null);
                }}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? priceErrorId : undefined}
                className="form-input min-h-11 w-full min-w-0 tabular-nums"
              />
              <span aria-hidden className="shrink-0 text-ink-soft">
                €
              </span>
            </div>
            <Button type="submit" variant="primary" size="sm" disabled={save.isPending}>
              Enregistrer
            </Button>
            {snapshot.finalPriceEur != null ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={save.isPending}
                onClick={() => save.mutate({ finalPriceEur: null })}
              >
                Retirer mon prix final
              </Button>
            ) : null}
          </div>
          {error ? (
            <p id={priceErrorId} role="alert" className="mt-1 text-xs font-semibold text-danger">
              {error}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-ink-soft">
            Noté pour vous seul, sur votre compte : il n’est jamais envoyé par email ni partagé. Il
            est effacé avec cette vente.
          </p>
        </form>
      ) : null}

      {withPrice ? (
        <p className="mt-2" data-testid="snapshot-gap">
          {gap
            ? `Écart avec mon plafond : prix final ${gapText(gap)}.`
            : snapshot.finalPriceEur != null
              ? "Écart avec mon plafond : aucun plafond n’était enregistré sur cette vente."
              : "Écart avec mon plafond : notez le prix final pour le voir."}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Échéancier indicatif d'une vente remportée : fin du délai de surenchère et paiement du prix, avec
 * l'article de chaque règle et « à confirmer avec votre avocat ». Seulement pour une saisie
 * immobilière au tribunal ; exportable en `.ics` (deux dates sur la journée, sans rappel, sans prix).
 */
function DeadlinesBlock({ snapshot }: { snapshot: FollowedSaleSnapshot }) {
  const [pending, setPending] = useState(false);
  const deadlines = saleDeadlines({
    saleDate: snapshot.saleDate,
    venueType: snapshot.saleVenueType,
    legalFramework: snapshot.saleLegalFramework,
  });

  async function download() {
    setPending(true);
    try {
      const file = await downloadSnapshotDeadlines({ snapshotId: snapshot.id });
      const url = URL.createObjectURL(file.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.filename;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (failure) {
      toast.error(userMessage(failure, "L’export de l’échéancier est indisponible."));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-3 text-sm" data-testid="snapshot-deadlines">
      <p className="font-semibold text-brand-navy">Échéancier indicatif</p>
      {deadlines ? (
        <>
          <ul className="mt-1 grid gap-2">
            {deadlines.map((deadline) => (
              <li key={deadline.key}>
                <span className="font-semibold">{deadline.label} :</span>{" "}
                {formatDate(deadline.isoDay)}
                <span className="block text-xs text-ink-soft">{deadline.source}</span>
                <span className="block text-xs text-ink-soft">{deadline.caveat}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 font-semibold text-brand-navy">{DEADLINES_CONFIRM_NOTICE}</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            disabled={pending}
            aria-busy={pending}
            onClick={() => void download()}
          >
            <CalendarPlus className="size-4" aria-hidden />
            {pending ? "Préparation…" : "Ajouter l’échéancier à mon agenda (.ics)"}
          </Button>
        </>
      ) : (
        <p className="mt-1 text-ink-soft">
          Nous ne calculons pas d’échéancier pour cette vente : il ne vise que les saisies
          immobilières au tribunal, et d’autres délais peuvent s’appliquer.{" "}
          {DEADLINES_CONFIRM_NOTICE}
        </p>
      )}
    </div>
  );
}
