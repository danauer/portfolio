// Turns the PlayStation snapshot (written by `npm run psn:sync`) into the numbers the
// /psn and /games pages chart. Everything here runs at build time.
import snapshotJson from '../data/psn/snapshot.json';
import storeJson from '../data/psn/store.json';

export interface TrophyCounts { bronze: number; silver: number; gold: number; platinum: number }
export interface RawGame {
  titleId: string;
  conceptId: number | null;
  name: string;
  image: string | null;
  icon: string | null;
  platform: string;
  service: string;
  minutes: number;
  playCount: number;
  firstPlayed: string | null;
  lastPlayed: string | null;
}
export interface TrophyTitle {
  npCommunicationId: string;
  name: string;
  icon: string;
  platform: string;
  progress: number;
  defined: TrophyCounts;
  earned: TrophyCounts;
  lastEarned: string;
}
export interface Purchased {
  titleId: string;
  productId: string;
  name: string;
  image: string | null;
  platform: 'PS4' | 'PS5';
  /** PS_PLUS = claimed with a subscription (access depends on it), NONE = bought. */
  membership: 'PS_PLUS' | 'NONE';
}
export interface Snapshot {
  generatedAt: string;
  profile: {
    accountId: string;
    onlineId: string | null;
    avatar: string | null;
    isPlus: boolean | null;
    trophyLevel: number;
    trophyProgress: number;
    trophyTier: number;
    earnedTrophies: TrophyCounts;
  };
  games: RawGame[];
  purchased: Purchased[];
  trophies: TrophyTitle[];
}

export const snapshot = snapshotJson as unknown as Snapshot;

/** A PlayStation Store listing picked for you, from src/data/psn/store.json. */
export interface StorePick {
  id: string;
  name: string;
  image: string | null;
  platforms: string[];
  priceCents: number;
  fullPriceCents: number;
  discount: number;
  isFree: boolean;
  plusOnly: boolean;
  genres: string[];
  sharedGenres: string[];
  because: string[];
  match: number;
  rank: number | null;
}
export interface Store {
  generatedAt: string;
  catalog: number;
  profile: { genre: string; weight: number }[];
  candidates: number;
  groups: { id: string; title: string; blurb: string; items: StorePick[] }[];
  /** Genre fit and store artwork for owned titles, keyed by title id. */
  owned: Record<string, { match: number | null; genres: string[]; image: string | null }>;
}
export const store = storeJson as unknown as Store;
export const productUrl = (productId: string) => `https://store.playstation.com/en-us/product/${productId}`;

export type Generation = 'PS5' | 'PS4';
export interface Game {
  /** Stable id: the PSN concept (one per game across PS4/PS5 versions) when there is one. */
  key: string;
  name: string;
  image: string | null;
  minutes: number;
  playCount: number;
  firstPlayed: number | null;
  lastPlayed: number | null;
  conceptId: number | null;
  /** Store page, when we know the product. */
  href: string | null;
  /** True when you own it but have never launched it. */
  unplayed: boolean;
  /** PS Plus claims depend on the subscription; purchases don't. Null when unknown. */
  membership: 'PS_PLUS' | 'NONE' | null;
  titleIds: string[];
  /** Hours split by console generation, most played first. */
  versions: { generation: Generation; minutes: number }[];
  /** Best-matching trophy set, when one could be found by name. */
  trophy: TrophyTitle | null;
}

const GENERATIONS: Record<string, Generation> = { ps5_native_game: 'PS5', ps4_game: 'PS4' };

export const storeUrl = (conceptId: number) => `https://store.playstation.com/concept/${conceptId}`;
const toUnix = (iso: string | null) => (iso ? Math.floor(new Date(iso).getTime() / 1000) : null);

/** Lowercase, drop ™/®/(…) and filler like "Edition", so "DEATH STRANDING™" matches "Death Stranding". */
export function normalizeTitle(name: string) {
  return name
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|edition|remastered|ps4|ps5|digital deluxe|deluxe|standard|game of the year|goty|directors cut)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * One row per game. PSN reports each console version (and sometimes stray 0-minute records)
 * separately; they share a concept id, so hours, plays and dates are merged on it. Media apps
 * and anything that isn't a PS4/PS5 game are dropped.
 */
export function psnGames(s: Snapshot = snapshot): Game[] {
  const groups = new Map<string, RawGame[]>();
  for (const g of s.games) {
    if (!(g.platform in GENERATIONS)) continue;
    const key = g.conceptId != null ? `c${g.conceptId}` : `n${normalizeTitle(g.name)}`;
    groups.set(key, [...(groups.get(key) ?? []), g]);
  }

  const trophiesByName = new Map<string, TrophyTitle[]>();
  for (const t of s.trophies) {
    const k = normalizeTitle(t.name);
    trophiesByName.set(k, [...(trophiesByName.get(k) ?? []), t]);
  }
  const earnedTotal = (t: TrophyTitle) => t.earned.bronze + t.earned.silver + t.earned.gold + t.earned.platinum;

  const purchasedById = new Map(s.purchased.map((p) => [p.titleId, p]));

  const playedGames = [...groups]
    .map(([key, raws]) => {
      const sorted = [...raws].sort((a, b) => b.minutes - a.minutes);
      const lead = sorted[0];
      const byGeneration = new Map<Generation, number>();
      for (const r of raws) byGeneration.set(GENERATIONS[r.platform], (byGeneration.get(GENERATIONS[r.platform]) ?? 0) + r.minutes);
      const firsts = raws.map((r) => toUnix(r.firstPlayed)).filter((x): x is number => x != null);
      const lasts = raws.map((r) => toUnix(r.lastPlayed)).filter((x): x is number => x != null);
      const candidates = raws.flatMap((r) => trophiesByName.get(normalizeTitle(r.name)) ?? []);
      return {
        key,
        name: lead.name.replace(/[™®©]/g, '').trim(),
        image: lead.image,
        minutes: raws.reduce((n, r) => n + r.minutes, 0),
        playCount: raws.reduce((n, r) => n + r.playCount, 0),
        firstPlayed: firsts.length ? Math.min(...firsts) : null,
        lastPlayed: lasts.length ? Math.max(...lasts) : null,
        conceptId: lead.conceptId,
        href: lead.conceptId != null ? storeUrl(lead.conceptId) : null,
        unplayed: false,
        membership: raws.map((r) => purchasedById.get(r.titleId)?.membership).find((m) => m === 'NONE') ?? raws.map((r) => purchasedById.get(r.titleId)?.membership).find(Boolean) ?? null,
        titleIds: raws.map((r) => r.titleId),
        versions: [...byGeneration].map(([generation, minutes]) => ({ generation, minutes })).sort((a, b) => b.minutes - a.minutes),
        trophy: candidates.sort((a, b) => earnedTotal(b) - earnedTotal(a))[0] ?? null,
      } satisfies Game;
    })
    .sort((a, b) => b.minutes - a.minutes);

  // Owned but never launched: in the purchased list, not in play history. PS4 and PS5 copies of one game count once.
  const playedIds = new Set(s.games.map((g) => g.titleId));
  const playedNames = new Set(playedGames.map((g) => normalizeTitle(g.name)));
  const unplayedGroups = new Map<string, Purchased[]>();
  for (const p of s.purchased) {
    const k = normalizeTitle(p.name);
    if (playedIds.has(p.titleId) || playedNames.has(k)) continue;
    unplayedGroups.set(k, [...(unplayedGroups.get(k) ?? []), p]);
  }
  const unplayedGames = [...unplayedGroups].map(([k, ps]) => {
    // Prefer the PS5 copy, and a purchase over a PS Plus claim.
    const lead = [...ps].sort((a, b) => Number(b.platform === 'PS5') - Number(a.platform === 'PS5'))[0];
    return {
      key: `p${k}`,
      name: lead.name.replace(/[™®©]/g, '').trim(),
      image: store.owned[lead.titleId]?.image ?? ps.map((p) => store.owned[p.titleId]?.image).find(Boolean) ?? lead.image,
      minutes: 0,
      playCount: 0,
      firstPlayed: null,
      lastPlayed: null,
      conceptId: null,
      href: productUrl(lead.productId),
      unplayed: true,
      membership: ps.some((p) => p.membership === 'NONE') ? 'NONE' : 'PS_PLUS',
      titleIds: ps.map((p) => p.titleId),
      versions: [],
      trophy: null,
    } satisfies Game;
  });

  return [...playedGames, ...unplayedGames].sort((a, b) => b.minutes - a.minutes);
}

export function analyzePsn(s: Snapshot = snapshot) {
  const games = psnGames(s);
  const played = games.filter((g) => g.minutes > 0);
  const totalMinutes = played.reduce((n, g) => n + g.minutes, 0);
  const now = new Date(s.generatedAt).getTime() / 1000;
  const sum = (list: Game[]) => list.reduce((n, g) => n + g.minutes, 0);

  const firstEver = Math.min(...played.map((g) => g.firstPlayed ?? Infinity));
  const years = Number.isFinite(firstEver) ? (now - firstEver) / (365.25 * 86400) : null;

  const top = played.slice(0, 15).map((g) => ({ ...g, share: g.minutes / totalMinutes }));
  const concentration = [
    { key: 'first', label: played[0]?.name ?? 'Top game', minutes: sum(played.slice(0, 1)) },
    { key: 'next4', label: 'Games 2–5', minutes: sum(played.slice(1, 5)) },
    { key: 'next15', label: 'Games 6–20', minutes: sum(played.slice(5, 20)) },
    { key: 'rest', label: `The other ${Math.max(0, played.length - 20)}`, minutes: sum(played.slice(20)) },
  ].filter((c) => c.minutes > 0);

  const generations = (['PS5', 'PS4'] as const)
    .map((generation) => ({ generation, minutes: played.reduce((n, g) => n + (g.versions.find((v) => v.generation === generation)?.minutes ?? 0), 0) }))
    .filter((x) => x.minutes > 0);

  // Games per year of first launch / last launch, over a gapless range of years.
  const yearRange = (pick: (g: Game) => number | null) => {
    const counts = new Map<number, { count: number; minutes: number }>();
    for (const g of played) {
      const t = pick(g);
      if (t == null) continue;
      const y = new Date(t * 1000).getUTCFullYear();
      const st = counts.get(y) ?? { count: 0, minutes: 0 };
      st.count += 1;
      st.minutes += g.minutes;
      counts.set(y, st);
    }
    const ys = [...counts.keys()];
    if (!ys.length) return [];
    const min = Math.min(...ys);
    return Array.from({ length: Math.max(...ys) - min + 1 }, (_, i) => ({ year: min + i, ...(counts.get(min + i) ?? { count: 0, minutes: 0 }) }));
  };

  const recent = played
    .filter((g) => g.lastPlayed != null)
    .sort((a, b) => b.lastPlayed! - a.lastPlayed!)
    .slice(0, 8);

  // Trophies ---------------------------------------------------------------
  const earned = s.profile.earnedTrophies;
  const trophyTotal = earned.bronze + earned.silver + earned.gold + earned.platinum;
  const withTrophies = played.filter((g) => g.trophy && g.trophy.defined.bronze + g.trophy.defined.silver + g.trophy.defined.gold + g.trophy.defined.platinum > 0);
  const completion = withTrophies.slice(0, 12);
  // Sets with a platinum available that you haven't earned, closest first.
  const closest = s.trophies
    .filter((t) => t.defined.platinum > 0 && t.earned.platinum === 0 && t.progress >= 40 && t.progress < 100)
    .sort((a, b) => b.progress - a.progress)
    .slice(0, 6);
  const platinums = s.trophies
    .filter((t) => t.earned.platinum > 0)
    .sort((a, b) => b.lastEarned.localeCompare(a.lastEarned));

  return {
    totals: {
      games: games.length,
      played: played.length,
      unplayed: games.length - played.length,
      totalMinutes,
      years,
      avgPerDay: years ? totalMinutes / (years * 365.25) : null,
    },
    top,
    concentration,
    generations,
    startedByYear: yearRange((g) => g.firstPlayed),
    lastPlayedByYear: yearRange((g) => g.lastPlayed),
    recent,
    trophies: { earned, total: trophyTotal, level: s.profile.trophyLevel, progress: s.profile.trophyProgress, sets: s.trophies.length },
    completion,
    closest,
    platinums,
  };
}
