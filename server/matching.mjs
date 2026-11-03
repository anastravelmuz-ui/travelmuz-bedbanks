// Suggestions de correspondance d'hôtels entre fournisseurs : nom + distance GPS.
// Ne crée jamais d'association : un administrateur valide (D-019, D-024).
import { normalize } from './hb-catalog.mjs';

const GENERIC = new Set(['hotel', 'hotels', 'the', 'and', 'by', 'resort', 'spa', 'suites', 'suite', 'boutique', 'otel', 'hôtel', 'de', 'la', 'le', 'les', 'el', 'al']);
export const tokens = (s, stop = new Set()) => normalize(s).split(' ').filter(t => t.length > 1 && !GENERIC.has(t) && !stop.has(t));

/** Similarité de noms (0 à 1) : coefficient de Dice sur les mots significatifs, bonus si inclusion. */
export function nameScore(a, b, stop = new Set()) {
  const A = new Set(tokens(a, stop)), B = new Set(tokens(b, stop));
  if (!A.size || !B.size) return normalize(a) === normalize(b) && normalize(a) ? 1 : 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  const dice = (2 * inter) / (A.size + B.size);
  // Bonus d'inclusion seulement si le nom le plus court compte au moins 2 mots significatifs (évite « Sultanahmet Suites »).
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  const contained = small.size >= 2 && [...small].every(t => big.has(t));
  return Math.min(1, contained ? Math.max(dice, 0.85) : dice);
}

export function distanceM(lat1, lng1, lat2, lng2) {
  if (![lat1, lng1, lat2, lng2].every(v => typeof v === 'number' && Number.isFinite(v))) return null;
  const R = 6371000, rad = x => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

const toNum = v => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };

/**
 * Classe les candidats. Score = 60 % nom + 40 % proximité (100 m → 1, 2 km → 0) ; sans coordonnées, nom seul plafonné.
 * « strong » : nom très proche (≥ 0,8) ET moins de 250 m. Jamais d'association automatique.
 */
export function rankCandidates(source, candidates, limit = 5) {
  const stop = new Set(normalize(source.city).split(' ').filter(Boolean)); // le nom de la ville ne départage pas
  return candidates.map(c => {
    const n = nameScore(source.name, c.name, stop);
    const d = distanceM(toNum(source.lat), toNum(source.lng), toNum(c.lat), toNum(c.lng));
    const prox = d == null ? null : d <= 100 ? 1 : d >= 2000 ? 0 : 1 - (d - 100) / 1900;
    const score = prox == null ? n * 0.7 : 0.6 * n + 0.4 * prox;
    return { ...c, nameScore: Math.round(n * 100) / 100, distanceM: d, score: Math.round(score * 100) / 100, strong: n >= 0.8 && d != null && d < 250 };
  }).filter(c => c.nameScore >= 0.3 || (c.distanceM != null && c.distanceM < 150))
    .sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---- Pays : nom anglais (Halalbooking) → code ISO 3166-1 alpha-2 (TBO, Hotelbeds) ----
const ALIASES = { turkey: 'TR', turkiye: 'TR', turquie: 'TR', 'emirats arabes unis': 'AE', 'united arab emirates': 'AE', uae: 'AE', 'united kingdom': 'GB', uk: 'GB', 'great britain': 'GB', 'united states': 'US', usa: 'US', 'south korea': 'KR', korea: 'KR', russia: 'RU', 'czech republic': 'CZ', 'bosnia and herzegovina': 'BA', maldives: 'MV', 'saudi arabia': 'SA' };
let regionIndex = null;
export function countryCode(name) {
  const n = normalize(name);
  if (!n) return null;
  if (ALIASES[n]) return ALIASES[n];
  if (!regionIndex) {
    regionIndex = new Map();
    try {
      // Noms anglais et français : Halalbooking répond selon la langue de l'appel (/fr/ pour les recherches).
      for (const lang of ['fr', 'en']) {
        const dn = new Intl.DisplayNames([lang], { type: 'region' });
        for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
          const code = String.fromCharCode(a, b); const label = dn.of(code);
          if (label && label !== code) regionIndex.set(normalize(label), code);
        }
      }
    } catch { /* Intl indisponible : alias seulement */ }
  }
  return regionIndex.get(n) ?? null;
}

/** Ville fournisseur correspondant à la ville Halalbooking (nom normalisé identique, sinon le plus proche). */
export function pickCity(cityName, cities) {
  const n = normalize(cityName);
  if (!n) return null;
  return cities.find(c => normalize(c.name) === n) ?? cities.find(c => normalize(c.name).startsWith(n + ' ') || normalize(c.name) === n.split(' ')[0]) ?? null;
}

/**
 * Villes fournisseur à explorer : la ville exacte d'abord, puis celles dont le nom contient la ville,
 * la sous-région ou la région Halalbooking (ex. « Kuta » → « Kuta, Bali », « Seminyak, Bali »…).
 * Les fournisseurs classent souvent un même quartier sous des villes différentes.
 */
export function pickCities(source, cities, max = 12) {
  const keys = [source.city, source.subregion, source.region].map(normalize).filter(k => k && k.length >= 3);
  const scored = [];
  for (const c of cities) {
    const n = normalize(c.name);
    // 0 : ville exacte · 1 : nom commençant par la ville · 2 : ville portant le nom de la (sous-)région (ex. « Bali, Bali »)
    // 3 : nom contenant la ville · 4 : nom contenant la (sous-)région
    const first = n.split(' ')[0], parts = n.split(' ');
    const rank = n === keys[0] ? 0 : keys[0] && n.startsWith(keys[0] + ' ') ? 1
      : keys.slice(1).some(k => n === k || n.startsWith(k + ' ' + k) || (first === k && parts.length <= 2)) ? 2
      : keys[0] && parts.includes(keys[0]) ? 3
      : keys.slice(1).some(k => parts.includes(k) || n.includes(' ' + k)) ? 4 : null;
    if (rank != null) scored.push({ ...c, rank });
  }
  return scored.sort((a, b) => a.rank - b.rank).slice(0, max);
}
