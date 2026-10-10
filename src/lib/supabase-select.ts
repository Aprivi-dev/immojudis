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
