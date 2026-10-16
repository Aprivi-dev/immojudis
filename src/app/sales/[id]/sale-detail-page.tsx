"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SaleDetailSkeleton, SaleNotFoundComponent } from "@/components/SaleDetailFallbacks";

import { SalePublicPreview } from "@/components/SalePublicPreview";
import { useAuth } from "@/hooks/use-auth";
import { markSaleViewed } from "@/hooks/use-viewed-sales";
import { getSaleById, getSalePreviewById } from "@/lib/queries";
import { fetchAccessPlan, fetchSaleUnlockStatus } from "@/lib/client-api";
import { loginPathWithRedirect, safeSalesReturnTo, saleDetailPath } from "@/lib/navigation";
import type { AuctionSale } from "@/lib/types";
import { queryKeys, type SaleAccessMode } from "@/lib/query-keys";
import type { SaleUnlockResult } from "@/lib/sale-unlocks";

const loadDiscoveryView = () => import("@/components/DiscoverySaleDetailView");
const loadSimplifiedViews = () => import("@/components/SimplifiedSaleDetailView");

const DiscoverySaleDetailView = dynamic(
  () => loadDiscoveryView().then((module) => module.DiscoverySaleDetailView),
  { loading: () => <SaleDetailSkeleton /> },
);

const AnalysisSaleDetailView = dynamic(
  () => loadSimplifiedViews().then((module) => module.AnalysisSaleDetailView),
  { loading: () => <SaleDetailSkeleton /> },
);

const UnlockedSaleDetailView = dynamic(
  () => loadSimplifiedViews().then((module) => module.UnlockedSaleDetailView),
  { loading: () => <SaleDetailSkeleton /> },
);

/**
 * Downloads the code of the views (not data) while the rights and the listing are being read, so
 * that it is already there when the access mode is known. A failed download is ignored: the
 * `dynamic` loaders import the module again when the view is actually displayed.
 */
function preloadSaleViews(views: { discovery: boolean; simplified: boolean }) {
  if (views.discovery) void loadDiscoveryView().catch(() => undefined);
  if (views.simplified) void loadSimplifiedViews().catch(() => undefined);
}

type SaleDetailRouteData = {
  sale: AuctionSale | null;
  preview: AuctionSale | null;
};

async function loadSaleDetailRouteData(
  id: string,
  options: { discovery?: boolean; unlocked?: boolean; authenticated: boolean },
): Promise<SaleDetailRouteData> {
  let sale = options.authenticated
    ? await getSaleById(id, { discovery: options.discovery, unlocked: options.unlocked })
    : null;
  // A sale that leaves the catalogue between the unlock check and this read is no longer served
  // by the full view: fall back to the free one rather than to a missing page.
  if (!sale && options.unlocked) sale = await getSaleById(id, { discovery: true });
  if (sale) return { sale, preview: null };
  return { sale: null, preview: await getSalePreviewById(id) };
}

export function SaleDetailPage({
  id,
  initialData,
  adjudicationStatisticsEnabled = false,
}: {
  id: string;
  initialData?: SaleDetailRouteData;
  adjudicationStatisticsEnabled?: boolean;
}) {
  // The page is statically generated and cached (ISR): it must not read the URL
  // during rendering (useSearchParams would force client-side rendering and hide
  // the public content from crawlers). The return link and the hash are read from
  // the browser location once mounted.
  const [from, setFrom] = useState<string | null>(null);
  const [requestedHash, setRequestedHash] = useState("");
  useEffect(() => {
    setFrom(new URLSearchParams(window.location.search).get("from"));
    const updateHash = () => setRequestedHash(window.location.hash);
    updateHash();
    window.addEventListener("hashchange", updateHash);
    return () => window.removeEventListener("hashchange", updateHash);
  }, [id]);
  const returnTo = safeSalesReturnTo(from) ?? "/sales";
  const loginReturnTo = `${saleDetailPath(id, safeSalesReturnTo(from))}${requestedHash}`;
  const { session, loading: authLoading, authError } = useAuth();
  const sessionKey = session?.user.id ?? "anonymous";
  const {
    data: entitlementsData,
    isLoading: entitlementsLoading,
    error: entitlementsError,
    refetch: retryEntitlements,
  } = useQuery({
    queryKey: queryKeys.featureEntitlementsPlan(sessionKey),
    queryFn: fetchAccessPlan,
    enabled: Boolean(session) && !authLoading,
    staleTime: 5 * 60_000,
  });
  const discovery = Boolean(session) && entitlementsData?.plan.hasAnalysisAccess !== true;
  // « 3 déblocages par mois » : un compte Découverte peut avoir débloqué cette vente. Sans réponse
  // (base sans le déblocage, erreur), la fiche reste la fiche gratuite.
  const unlockEnabled = discovery && !authLoading && Boolean(entitlementsData);
  const queryClient = useQueryClient();
  // The unlock status only depends on the session: it is read together with the rights instead of
  // after them (it is the account's own status, and it only decides the view once the rights say
  // « Découverte », see `unlockEnabled`). Once the rights are known to include the analysis, it is
  // no longer read.
  const entitlementsKnown = Boolean(entitlementsData);
  const unlockQuery = useQuery({
    queryKey: queryKeys.saleUnlock(id, sessionKey),
    queryFn: () => fetchSaleUnlockStatus(id),
    enabled: Boolean(session) && !authLoading && (!entitlementsKnown || discovery),
    staleTime: 60_000,
    // One more try before the free view is shown with a notice: a transient failure must not look
    // like a lost unlock.
    retry: 1,
    retryDelay: 800,
  });
  const unlockReady = !unlockEnabled || unlockQuery.isSuccess || unlockQuery.isError;
  const unlocked = unlockEnabled && unlockQuery.data?.unlocked === true;
  const accessMode: SaleAccessMode = !discovery ? "analysis" : unlocked ? "unlocked" : "discovery";
  const accessReady = !session || (Boolean(entitlementsData) && unlockReady);
  const [justUnlocked, setJustUnlocked] = useState(false);
  const handleSaleUnlocked = (result: SaleUnlockResult) => {
    setJustUnlocked(true);
    queryClient.setQueryData(queryKeys.saleUnlock(id, sessionKey), result);
    void queryClient.invalidateQueries({ queryKey: ["sale-detail", id] });
  };
  const signedIn = Boolean(session) && !authLoading;
  useEffect(() => {
    if (!signedIn) return;
    if (entitlementsKnown) {
      preloadSaleViews({ discovery, simplified: !discovery || unlockEnabled });
      return;
    }
    // Rights not known yet: the code of both families of views is fetched now, and the free
    // listing (the one every signed-in account may read) is read while the rights are being
    // checked. It is only displayed if the rights say « Découverte » (`accessReady` below); any
    // other mode reads its own view afterwards, exactly as before.
    preloadSaleViews({ discovery: true, simplified: true });
    void queryClient.prefetchQuery({
      queryKey: queryKeys.saleDetail(id, sessionKey, "discovery"),
      queryFn: () =>
        loadSaleDetailRouteData(id, { discovery: true, unlocked: false, authenticated: true }),
      staleTime: 5 * 60_000,
    });
  }, [signedIn, entitlementsKnown, discovery, unlockEnabled, queryClient, id, sessionKey]);
  const canUseServerInitialData =
    initialData?.sale?.id === id || (!session && initialData?.preview?.id === id);
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: queryKeys.saleDetail(id, sessionKey, accessMode),
    queryFn: () =>
      loadSaleDetailRouteData(id, {
        discovery: accessMode === "discovery",
        unlocked: accessMode === "unlocked",
        authenticated: Boolean(session),
      }),
    enabled: !authLoading && accessReady,
    initialData: canUseServerInitialData ? initialData : undefined,
    staleTime: 5 * 60_000,
  });
  // Right after « Confirmer le déblocage » the key of the query changes (the unlocked view is a
  // different read): the free view that was on screen is kept, with a banner, instead of a blank
  // skeleton, and a failed re-read never ends on the error page (the unlock is already recorded).
  const freeViewBeforeUnlock =
    justUnlocked && accessMode === "unlocked" && !data?.sale
      ? (queryClient.getQueryData<SaleDetailRouteData>(
          queryKeys.saleDetail(id, sessionKey, "discovery"),
        )?.sale ?? null)
      : null;
  const sale = data?.sale ?? null;
  const preview = data?.preview ?? null;
  // The listing may already be in the cache (read while the rights were being checked): it only
  // counts as viewed once it can be displayed.
  const displayable = !authLoading && accessReady;
  useEffect(() => {
    if (displayable && sale?.id) markSaleViewed(sale.id);
  }, [displayable, sale?.id]);

  useEffect(() => {
    if (authLoading || !accessReady || !sale?.id) return;
    let frame = 0;
    const revealAnchor = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        let targetId: string;
        try {
          targetId = decodeURIComponent(window.location.hash.slice(1));
        } catch {
          return;
        }
        if (targetId)
          document
            .getElementById(targetId)
            ?.scrollIntoView({ behavior: "instant", block: "start" });
      });
    };
    revealAnchor();
    window.addEventListener("hashchange", revealAnchor);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", revealAnchor);
    };
  }, [sale?.id, authLoading, accessReady]);

  if (!authLoading && authError) {
    return (
      <main id="contenu" className="mx-auto my-12 max-w-xl px-4">
        <section role="alert" className="rounded-lg border border-border bg-white p-6">
          <h1 className="text-xl font-semibold">Connexion à renouveler</h1>
          <p className="mt-3 text-sm text-muted-foreground">{authError}</p>
          <a
            href={loginPathWithRedirect(loginReturnTo, { mode: "login", reason: "fiche" })}
            className="mt-5 inline-flex min-h-11 items-center rounded-md bg-brand-navy px-4 py-2 text-white"
          >
            Se reconnecter
          </a>
        </section>
      </main>
    );
  }

  if (!authLoading && session && entitlementsError && !entitlementsData) {
    return (
      <section
        role="alert"
        className="mx-auto my-12 max-w-xl rounded-lg border border-border bg-white p-6"
      >
        <h1 className="text-xl font-semibold">Vos droits d’accès n’ont pas pu être vérifiés</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Réessayez pour retrouver la version de l’annonce incluse dans votre offre.
        </p>
        <button
          type="button"
          className="mt-5 rounded-md bg-brand-navy px-4 py-2 text-white"
          onClick={() => void retryEntitlements()}
        >
          Réessayer
        </button>
      </section>
    );
  }
  // The server already rendered the public page of this sale. Keep it on screen
  // while the session is being restored: crawlers and signed-out visitors see
  // the real content immediately instead of a skeleton.
  const serverPreview = initialData?.preview?.id === id ? initialData.preview : null;
  if (authLoading && serverPreview && !initialData?.sale) {
    return (
      <SalePublicPreview
        saleId={id}
        preview={serverPreview}
        returnTo={returnTo}
        requestedHash={requestedHash}
        adjudicationStatisticsEnabled={adjudicationStatisticsEnabled}
      />
    );
  }
  if (freeViewBeforeUnlock && !authLoading && accessReady && (isLoading || error)) {
    return (
      <>
        {error ? (
          <div
            role="alert"
            className="mx-auto mt-4 flex max-w-[1260px] flex-wrap items-center gap-3 rounded-lg border border-amber-700/30 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          >
            <p className="font-medium">
              Vente débloquée, mais le détail n’a pas pu être chargé. Votre déblocage est conservé.
            </p>
            <button
              type="button"
              className="min-h-10 rounded-md border border-amber-700/40 bg-white px-3 font-semibold text-amber-900"
              onClick={() => void refetch()}
              disabled={isFetching}
            >
              Réessayer
            </button>
          </div>
        ) : (
          <div
            role="status"
            className="mx-auto mt-4 max-w-[1260px] rounded-lg border border-emerald-700/30 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-900"
          >
            Vente débloquée. Chargement du détail…
          </div>
        )}
        <DiscoverySaleDetailView
          sale={freeViewBeforeUnlock}
          returnTo={returnTo}
          adjudicationStatisticsEnabled={adjudicationStatisticsEnabled}
          unlockStatus={unlockQuery.data ?? null}
          justUnlocked={justUnlocked}
          onSaleUnlocked={handleSaleUnlocked}
        />
      </>
    );
  }
  if (authLoading || entitlementsLoading || !accessReady || isLoading) {
    return <SaleDetailSkeleton />;
  }
  if (error) throw error;
  if (!sale && preview) {
    return (
      <SalePublicPreview
        saleId={id}
        preview={preview}
        returnTo={returnTo}
        requestedHash={requestedHash}
        adjudicationStatisticsEnabled={adjudicationStatisticsEnabled}
      />
    );
  }
  if (!sale && !session) {
    return (
      <main id="contenu" className="mx-auto my-16 max-w-xl px-4">
        <section className="rounded-lg border border-border bg-white p-6">
          <h1 className="font-display text-2xl font-semibold">Consulter cette annonce</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            L’aperçu de cette annonce n’est pas disponible. Connectez-vous pour vérifier l’accès à
            la fiche complète.
          </p>
          <a
            href={loginPathWithRedirect(loginReturnTo, { reason: "fiche" })}
            className="mt-5 inline-flex min-h-11 items-center rounded-md bg-brand-navy px-4 py-2 text-sm font-medium text-white"
          >
            Se connecter ou créer un compte
          </a>
          <a href={returnTo} className="mt-4 block text-sm underline underline-offset-4">
            Retour aux résultats
          </a>
        </section>
      </main>
    );
  }
  if (!sale) return <SaleNotFoundComponent />;

  if (accessMode === "unlocked") {
    return (
      <UnlockedSaleDetailView
        sale={sale}
        returnTo={returnTo}
        adjudicationStatisticsEnabled={adjudicationStatisticsEnabled}
        unlockStatus={unlockQuery.data ?? null}
        justUnlocked={justUnlocked}
      />
    );
  }
  return accessMode === "discovery" ? (
    <>
      {unlockEnabled && unlockQuery.isError ? (
        <div
          role="alert"
          className="mx-auto mt-4 flex max-w-[1260px] flex-wrap items-center gap-3 rounded-lg border border-amber-700/30 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <p className="font-medium">État de vos déblocages indisponible</p>
          <p>
            Si vous avez déjà débloqué cette vente, elle apparaîtra de nouveau dès que l’état sera
            relu.
          </p>
          <button
            type="button"
            className="min-h-10 rounded-md border border-amber-700/40 bg-white px-3 font-semibold text-amber-900"
            onClick={() => void unlockQuery.refetch()}
            disabled={unlockQuery.isFetching}
          >
            Réessayer
          </button>
        </div>
      ) : null}
      <DiscoverySaleDetailView
        sale={sale}
        returnTo={returnTo}
        adjudicationStatisticsEnabled={adjudicationStatisticsEnabled}
        unlockStatus={unlockQuery.data ?? null}
        onSaleUnlocked={handleSaleUnlocked}
      />
    </>
  ) : (
    <AnalysisSaleDetailView
      sale={sale}
      returnTo={returnTo}
      adjudicationStatisticsEnabled={adjudicationStatisticsEnabled}
    />
  );
}
