"use client";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Card } from "@/components/ui/primitives";
import { useAuth } from "@/hooks/use-auth";
import { deleteFollowedSaleSnapshot, fetchFollowedSaleSnapshots } from "@/lib/client-api";
import { favoriteDossierStatusLabel } from "@/lib/favorite-dossier-shared";
import { formatDate, formatPrice, propertyTypeLabel } from "@/lib/format";
import type {
  FollowedSaleSnapshot,
  FollowedSaleSnapshotResult,
} from "@/lib/followed-sale-snapshots-shared";
import { queryKeys } from "@/lib/query-keys";
import type { SurenchereWindow } from "@/lib/surenchere-window";
import { SURENCHERE_WINDOW_DAYS } from "@/lib/surenchere-window";
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
      <ul className="mt-4 grid gap-4 lg:grid-cols-2">
        {snapshots.map((snapshot) => (
          <li key={snapshot.id} className="min-w-0">
            <SnapshotCard
              snapshot={snapshot}
              busy={remove.isPending && remove.variables === snapshot.id}
              onRemove={() => remove.mutate(snapshot.id)}
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
          label="Mon statut"
          value={
            snapshot.personalStatus ? favoriteDossierStatusLabel(snapshot.personalStatus) : "Aucun"
          }
        />
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
        <p className="font-semibold text-brand-navy">Résultat</p>
        <p className="mt-1" data-testid="snapshot-result">
          {resultText(snapshot.result)}
        </p>
      </div>

      <SurenchereBlock info={snapshot.surenchere} lawyerName={snapshot.lawyerName} />

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

function SurenchereBlock({
  info,
  lawyerName,
}: {
  info: SurenchereWindow;
  lawyerName: string | null;
}) {
  return (
    <div className="mt-3 text-sm" data-testid="snapshot-surenchere">
      <p className="font-semibold text-brand-navy">Fenêtre de surenchère</p>
      {info.kind === "window" ? (
        <>
          <p className="mt-1">
            {info.adjudicationConfirmed
              ? `Date limite indicative : ${formatDate(info.deadline)} (${SURENCHERE_WINDOW_DAYS} jours après l’audience du ${formatDate(info.hearingDay)}).`
              : `Le résultat n’est pas connu. Si le bien a été adjugé, la surenchère est possible jusqu’au ${formatDate(info.deadline)} (date indicative : ${SURENCHERE_WINDOW_DAYS} jours après l’audience du ${formatDate(info.hearingDay)}).`}{" "}
            {info.expired
              ? "Cette fenêtre est échue."
              : info.daysLeft === 0
                ? "C’est le dernier jour."
                : `Il reste ${info.daysLeft} jour${info.daysLeft === 1 ? "" : "s"}.`}
          </p>
          <p className="mt-1 text-ink-soft">
            La surenchère se forme par acte d’avocat : la date exacte et les conditions se
            confirment avec l’avocat
            {lawyerName ? ` de la vente (${lawyerName})` : " de la vente"} ou un avocat de{" "}
            <Link href="/avocats" className="font-semibold text-gold-text underline">
              l’annuaire
            </Link>
            .
          </p>
        </>
      ) : info.kind === "no_date" ? (
        <p className="mt-1 text-ink-soft">
          La date d’audience n’est pas connue : la fenêtre ne peut pas être calculée. Interrogez
          l’avocat de la vente.
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
