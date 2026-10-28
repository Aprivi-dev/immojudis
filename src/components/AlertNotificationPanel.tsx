import { useMutation, useQueryClient } from "@tanstack/react-query";
import Check from "lucide-react/dist/esm/icons/check.js";
import Inbox from "lucide-react/dist/esm/icons/inbox.js";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.js";
import { toast } from "@/lib/toast";
import Link from "next/link";
import { updateAlertNotification } from "@/lib/client-api";
import { AlertEmailRecapToggle } from "@/components/AlertEmailRecapToggle";
import { PEPITE_ALERT_REASON, PEPITE_LABEL } from "@/lib/pepite-copy";
import { cleanSaleTitle } from "@/lib/sale-title";
import type { AlertNotificationSummary } from "@/lib/alert-notifications";
import { userMessage } from "@/lib/user-messages";
import * as queryKeys from "@/lib/query-keys";

export default function AlertNotificationPanel({
  mobile,
  userId,
  notifications,
  isLoading,
  isFetching,
  isError,
  onRefresh,
  onClose,
}: {
  mobile: boolean;
  userId: string;
  notifications: AlertNotificationSummary[];
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  onRefresh: () => unknown;
  onClose: () => void;
}) {
  const NOTIFICATION_QUERY_KEY = queryKeys.alertNotifications(userId);
  const queryClient = useQueryClient();
  const unreadCount = notifications.filter((notification) => !notification.readAt).length;

  async function restoreNotification(notificationId: string) {
    try {
      await updateAlertNotification({ notificationId, action: "restore" });
      await queryClient.invalidateQueries({ queryKey: NOTIFICATION_QUERY_KEY });
    } catch (error) {
      toast.error(userMessage(error, "Impossible de rétablir cette notification."));
    }
  }

  const updateMutation = useMutation({
    mutationFn: updateAlertNotification,
    onSuccess: async (_result, variables) => {
      await queryClient.invalidateQueries({ queryKey: NOTIFICATION_QUERY_KEY });
      if (variables.action === "dismiss") {
        toast("Notification masquée", {
          // Une action « Annuler » ne s'éteint pas d'elle-même au bout de 5 s (WCAG 2.2.1) : elle
          // reste jusqu'à ce qu'on la ferme. Un seul message à la fois (même identifiant).
          id: "alert-notification-dismissed",
          duration: Infinity,
          closeButton: true,
          action: {
            label: "Annuler",
            onClick: () => void restoreNotification(variables.notificationId),
          },
        });
      }
    },
    onError: (error) => toast.error(userMessage(error, "Action impossible")),
  });

  return (
    <div
      role="dialog"
      aria-label="Notifications d'alertes"
      className={
        mobile
          ? "mt-3 w-full overflow-hidden rounded-lg border border-border bg-white shadow-xl"
          : "absolute right-0 top-full z-50 mt-2 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border bg-white shadow-xl"
      }
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-foreground">Alertes</div>
          <div className="text-xs text-muted-foreground">{unreadCount} non lue(s)</div>
        </div>
        <button
          type="button"
          aria-label="Rafraîchir"
          onClick={() => void onRefresh()}
          className="inline-grid size-11 place-items-center rounded-md border border-border text-muted-foreground hover:border-gold/50 hover:text-gold-text"
        >
          {isFetching ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </button>
      </div>

      {/* Un compte gratuit reçoit un récapitulatif par semaine, l'offre Analyse un par jour. */}
      <AlertEmailRecapToggle
        userId={userId}
        className="flex items-center justify-between gap-3 border-b border-border bg-muted/20 px-4 py-3 text-sm"
      />

      <div className="max-h-[28rem] overflow-y-auto">
        {isError ? (
          <p role="alert" className="px-4 py-8 text-sm text-destructive">
            Notifications indisponibles. Utilisez « Rafraîchir » pour réessayer.
          </p>
        ) : isLoading ? (
          <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Chargement
          </div>
        ) : notifications.length ? (
          notifications.map((notification) => (
            <NotificationItem
              key={notification.id}
              notification={notification}
              disabled={updateMutation.isPending}
              onOpen={() => onClose()}
              onRead={() =>
                updateMutation.mutate({
                  notificationId: notification.id,
                  action: notification.readAt ? "unread" : "read",
                })
              }
              onDismiss={() =>
                updateMutation.mutate({
                  notificationId: notification.id,
                  action: "dismiss",
                })
              }
            />
          ))
        ) : (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            <Inbox className="mx-auto mb-2 h-5 w-5" />
            Aucune nouvelle vente pour vos alertes pour le moment.
          </div>
        )}
      </div>
    </div>
  );
}

function NotificationItem({
  notification,
  disabled,
  onOpen,
  onRead,
  onDismiss,
}: {
  notification: AlertNotificationSummary;
  disabled: boolean;
  onOpen: () => void;
  onRead: () => void;
  onDismiss: () => void;
}) {
  const unread = !notification.readAt;
  const title = cleanSaleTitle(notification.saleTitle) || "Vente judiciaire";
  const location = [notification.city, notification.department].filter(Boolean).join(" · ");

  return (
    <div className="border-b border-border last:border-b-0">
      <div className="grid grid-cols-[1fr_auto] gap-3 px-4 py-3">
        <Link href={`/sales/${notification.saleId}`} onClick={onOpen} className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            {unread ? <span className="h-2 w-2 rounded-full bg-gold" aria-hidden /> : null}
            <span className="truncate text-sm font-semibold text-foreground">{title}</span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {notification.alertName}
            {location ? ` · ${location}` : ""}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {notification.reasons.slice(0, 2).map((reason) => (
              <span
                key={reason}
                className="rounded-full bg-gold/10 px-2 py-0.5 text-[11px] font-semibold text-gold-text"
              >
                {reason === PEPITE_ALERT_REASON ? PEPITE_LABEL : reason}
              </span>
            ))}
            {notification.marketDiscountPct != null ? (
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                {Math.round(notification.marketDiscountPct)} % sous la valeur estimée (base DVF)
              </span>
            ) : null}
          </div>
          <div className="mt-2 text-[11px] text-muted-foreground">
            {formatNotificationDate(notification.scheduledFor)}
          </div>
        </Link>

        <div className="flex flex-col gap-2">
          <button
            type="button"
            aria-label={unread ? "Marquer comme lue" : "Marquer comme non lue"}
            disabled={disabled}
            onClick={onRead}
            className="inline-grid size-11 place-items-center rounded-md border border-border text-muted-foreground hover:border-gold/50 hover:text-gold-text disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Check className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="Masquer"
            disabled={disabled}
            onClick={onDismiss}
            className="inline-grid size-11 place-items-center rounded-md border border-border text-muted-foreground hover:border-destructive/40 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function formatNotificationDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
