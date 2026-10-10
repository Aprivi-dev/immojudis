type ColumnNames<TSelect extends string> = TSelect extends `${infer Head},${infer Tail}`
  ? Head | ColumnNames<Tail>
  : TSelect;

/**
 * Ligne partielle correspondant à un `select("a,b,c")` aux colonnes simples.
 *
 * À utiliser quand la liste des colonnes est une constante littérale : le client typé de
 * Supabase infère alors déjà ce type, et le helper permet de le nommer pour les fonctions
 * qui reçoivent les lignes.
 */
export type SelectedRow<TRow, TSelect extends string> = Pick<
  TRow,
  ColumnNames<TSelect> & keyof TRow
>;

type JoinColumns<TColumns extends readonly string[]> = TColumns extends readonly [
  infer Head extends string,
  ...infer Tail extends readonly string[],
]
  ? Tail extends readonly []
    ? Head
    : `${Head},${JoinColumns<Tail>}`
  : string;

/**
 * `columns.join(",")` avec le type littéral de la chaîne obtenue, pour que le client typé
 * infère les lignes d'une liste de colonnes déclarée `as const`.
 */
export function joinColumns<const TColumns extends readonly string[]>(
  columns: TColumns,
): JoinColumns<TColumns> {
  return columns.join(",") as JoinColumns<TColumns>;
}
