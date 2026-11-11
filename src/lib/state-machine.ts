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
  /** La table, telle qu'elle a été écrite : pour les tests et la documentation. */
  readonly table: TransitionTable<State, Event>;
  /** État suivant ; l'état reçu, inchangé, quand il n'accepte pas cet événement. */
  readonly transition: (state: State, event: Event) => State;
};

export function defineMachine<State extends Tagged<string>, Event extends Typed<string>>(
  initial: State,
  table: TransitionTable<State, Event>,
): StateMachine<State, Event> {
  type Handler = (state: State, event: Event) => State;
  const rows = table as unknown as Record<string, Record<string, Handler>>;
  return {
    initial,
    table,
    transition(state, event) {
      const row = rows[state.status];
      // `Object.hasOwn` : un type d'événement nommé comme une propriété héritée (« toString »,
      // « constructor ») ne doit pas trouver une fonction d'`Object.prototype`.
      return Object.hasOwn(row, event.type) ? row[event.type](state, event) : state;
    },
  };
}

/**
 * Types d'événements qu'un état accepte. Hors de l'objet rendu par `defineMachine` : les pages
 * qui n'en ont pas besoin ne l'embarquent pas (le budget JavaScript de `/sales` est serré).
 */
export function acceptedEvents<State extends Tagged<string>, Event extends Typed<string>>(
  machine: StateMachine<State, Event>,
  status: State["status"],
): Event["type"][] {
  return Object.keys(machine.table[status]) as Event["type"][];
}
