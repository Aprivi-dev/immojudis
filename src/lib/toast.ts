import type { ExternalToast } from "sonner";

/**
 * Notifications de l'application : même API que le `toast` de sonner (`toast(...)`,
 * `toast.success`, `.error`, `.info`, `.warning`, `.message`, `.loading`, `.dismiss`), mais ce
 * module ne charge pas sonner. La bibliothèque (≈ 14 Ko gzip) et son composant `Toaster` ne sont
 * téléchargés qu'à la première notification : `LazyToaster` (monté dans les fournisseurs) charge
 * `AppToaster`, qui s'enregistre ici une fois affiché. Une notification émise avant ce moment
 * attend dans une file simple, puis part dans l'ordre : aucune n'est perdue.
 *
 * Importer `toast` d'ici, jamais de `sonner` : un import direct remettrait la bibliothèque dans le
 * JavaScript de la page. Seul `AppToaster` importe sonner.
 */

type Message = Parameters<SonnerToast["success"]>[0];
type Id = string | number;
type SonnerToast = typeof import("sonner").toast;

type Method = "default" | "success" | "error" | "info" | "warning" | "message" | "loading";
type Queued = { method: Method; message: Message; options: ExternalToast; id: Id };

/** Au-delà, les plus anciennes sont écartées : la file ne peut pas grossir sans limite. */
export const TOAST_QUEUE_LIMIT = 50;

let real: SonnerToast | null = null;
let requested = false;
let queue: Queued[] = [];
let counter = 0;
const listeners = new Set<() => void>();

function notifyRequested(): void {
  if (requested) return;
  requested = true;
  for (const listener of [...listeners]) listener();
}

/** Pour `LazyToaster` : faut-il charger le composant d'affichage ? */
export function subscribeToastRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isToastRequested(): boolean {
  return requested;
}

function callReal(target: SonnerToast, method: Method, message: Message, options: ExternalToast) {
  return method === "default" ? target(message, options) : target[method](message, options);
}

/**
 * Appelé par `AppToaster` une fois monté (avec le `toast` de sonner), puis avec `null` quand il
 * est démonté. Vide la file, dans l'ordre d'émission.
 */
export function registerToaster(target: SonnerToast | null): void {
  real = target;
  if (!target) return;
  const waiting = queue;
  queue = [];
  for (const item of waiting) {
    try {
      callReal(target, item.method, item.message, { ...item.options, id: item.id });
    } catch (error) {
      console.error("[toast] Notification en échec", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function emit(method: Method, message: Message, options: ExternalToast = {}): Id {
  if (real) return callReal(real, method, message, options);
  // Côté serveur il n'y a personne à notifier.
  if (typeof window === "undefined") return options.id ?? "";
  // L'identifiant est connu tout de suite, comme avec sonner : `toast.dismiss(id)` fonctionne
  // aussi pour une notification encore en file.
  counter += 1;
  const id = options.id ?? `toast-${counter}`;
  queue.push({ method, message, options, id });
  if (queue.length > TOAST_QUEUE_LIMIT) queue = queue.slice(-TOAST_QUEUE_LIMIT);
  notifyRequested();
  return id;
}

function dismiss(id?: Id): Id | undefined {
  if (real) return real.dismiss(id);
  queue = id === undefined ? [] : queue.filter((item) => item.id !== id);
  return id;
}

export const toast = Object.assign(
  (message: Message, options?: ExternalToast) => emit("default", message, options),
  {
    success: (message: Message, options?: ExternalToast) => emit("success", message, options),
    error: (message: Message, options?: ExternalToast) => emit("error", message, options),
    info: (message: Message, options?: ExternalToast) => emit("info", message, options),
    warning: (message: Message, options?: ExternalToast) => emit("warning", message, options),
    message: (message: Message, options?: ExternalToast) => emit("message", message, options),
    loading: (message: Message, options?: ExternalToast) => emit("loading", message, options),
    dismiss,
  },
);

/** Réservé aux tests : remet à zéro l'état du module. */
export function resetToastForTests(): void {
  real = null;
  requested = false;
  queue = [];
  counter = 0;
  listeners.clear();
}
