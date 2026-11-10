// Équivalent EUR indicatif à partir d'un taux BCE (1 EUR = rate devise). null si conversion impossible : jamais de taux inventé.
export function convertToEur(amount, currency, fx) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || !fx?.rates || typeof fx.date !== 'string') return null;
  const c = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  if (c === 'EUR') return { amount, rate: 1, date: fx.date, currency: c };
  const rate = fx.rates[c];
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return null;
  return { amount: Math.round(amount / rate * 100) / 100, rate, date: fx.date, currency: c };
}
