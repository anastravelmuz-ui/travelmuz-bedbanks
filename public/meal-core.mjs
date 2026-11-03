// Pensions : code commun pour filtrer et comparer entre fournisseurs. Le libellé fournisseur reste affiché.
// null = pension non reconnue : jamais présumée équivalente.
export const MEAL_LABELS = { RO: 'Chambre seule', BB: 'Petit déjeuner', HB: 'Demi-pension', FB: 'Pension complète', AI: 'Tout compris' };

const TBO = { Room_Only: 'RO', RoomOnly: 'RO', BreakFast: 'BB', Breakfast: 'BB', Breakfast_For_1: 'BB', Breakfast_For_2: 'BB', Half_Board: 'HB', HalfBoard: 'HB', Full_Board: 'FB', FullBoard: 'FB', All_Inclusive: 'AI', All_Inclusive_All_Meal: 'AI' };
const TEXT = [
  [/tout[- ]?(compris|inclus)|all[- ]?inclusive|ultra/i, 'AI'],
  [/pension compl[eè]te|full[- ]?board|petit d[ée]jeuner,? d[ée]jeuner et d[îi]ner/i, 'FB'],
  [/demi[- ]?pension|half[- ]?board|petit d[ée]jeuner et d[îi]ner/i, 'HB'],
  [/petit[- ]?d[ée]jeuner|breakfast|\bbb\b/i, 'BB'],
  [/chambre seule|sans repas|room[- ]?only|self[- ]?catering|logement seul/i, 'RO'],
];
export function mealCodeFromTbo(value) { return value == null ? null : TBO[String(value)] ?? null; }
export function mealCodeFromText(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  for (const [re, code] of TEXT) if (re.test(value)) return code;
  return null;
}
