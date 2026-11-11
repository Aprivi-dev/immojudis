/**
 * Machine à états explicite, sans dépendance : une table `état → événement → état suivant`.
 *
 * Pourquoi : un parcours tenu par plusieurs `useState` (ou par des `setStatus(...)` dispersés) laisse
 * écrire des combinaisons impossibles — « en cours » pour toujours, une erreur par-dessus un écran
 * qui fonctionne, la réponse d'une ancienne demande qui écrase la nouvelle. Ici, tout ce qui peut
 * arriver est écrit à un seul endroit :
 *
 * - chaque état liste les événements qu'il accepte ; un événement absent de la liste est **ignoré**
 *   (l'état est rendu tel quel, même référence), il ne peut donc pas produire d'état impossible ;
 * - la table doit nommer tous les états (le typage refuse un état oublié) ;
 * - la transition est une fonction pure : elle se teste sans React et sans réseau.
 *
 * Convention du dépôt : une machine par fichier `*-machine.ts`, à côté de ce qu'elle pilote, avec
 * son test, et une ligne dans `docs/architecture/machines-a-etats.md`. Côté interface, on la branche
 * avec `useReducer(machine.transition, machine.initial)`.
 */

type Tagged<Tag extends string> = { readonly status: Tag };
type Typed<Type extends string> = { readonly type: Type };

/**
 * Table des transitions. Pour chaque état, les événements acceptés et l'état qu'ils produisent.
 * La fonction reçoit l'état et l'événement déjà réduits à leur variante : pas de `as`.
 */
export type TransitionTable<State extends Tagged<string>, Event extends Typed<string>> = {
  readonly [Status in State["status"]]: {
    readonly [Type in Event["type"]]?: (
      state: Extract<State, Tagged<Status>>,
      event: Extract<Event, Typed<Type>>,
    ) => State;
  };
};

export type StateMachine<State extends Tagged<string>, Event extends Typed<string>> = {
  readonly initial: State;
  /** État suivant ; l'état reçu, inchangé, quand il n'accepte pas cet événement. */
  readonly transition: (state: State, event: Event) => State;
  /** Vrai si cet état accepte ce type d'événement (utile pour désactiver un bouton). */
  readonly accepts: (state: State, type: Event["type"]) => boolean;
  /** Types d'événements acceptés par un état : sert aux tests et à la documentation. */
  readonly acceptedEvents: (status: State["status"]) => Event["type"][];
  /** Tous les états de la table, dans l'ordre de leur déclaration. */
  readonly statuses: State["status"][];
};

export function defineMachine<State extends Tagged<string>, Event extends Typed<string>>(
  initial: State,
  table: TransitionTable<State, Event>,
): StateMachine<State, Event> {
  type Handler = (state: State, event: Event) => State;
  const handlers = table as unknown as Record<string, Record<string, Handler | undefined>>;
  // `Object.hasOwn` : un type d'événement nommé comme une propriété héritée (« toString »,
  // « constructor ») ne doit pas trouver une fonction d'`Object.prototype`.
  const handlerFor = (status: string, type: string): Handler | undefined => {
    const row = Object.hasOwn(handlers, status) ? handlers[status] : undefined;
    return row && Object.hasOwn(row, type) ? row[type] : undefined;
  };

  return {
    initial,
    transition(state, event) {
      const handler = handlerFor(state.status, event.type);
      return handler ? handler(state, event) : state;
    },
    accepts: (state, type) => handlerFor(state.status, type) !== undefined,
    acceptedEvents: (status) =>
      Object.keys(Object.hasOwn(handlers, status) ? handlers[status] : {}).filter(
        (type) => handlerFor(status, type) !== undefined,
      ) as Event["type"][],
    statuses: Object.keys(handlers) as State["status"][],
  };
}
