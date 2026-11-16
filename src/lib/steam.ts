// Turns the Steam snapshot (written by `npm run steam:sync`) into the numbers the
// /steam pages chart. Everything here runs at build time.
import snapshotJson from '../data/steam/snapshot.json';
import tagLists from '../data/steam/tags.json';

const META_TAGS = new Set(tagLists.meta);
const SOFTWARE_GENRES = new Set(tagLists.softwareGenres);

export interface Tag { name: string; votes: number }
export interface Rare { name: string; description: string; percent: number; unlockedAt: number | null }
export interface Game {
  appid: number;
  name: string;
  icon: string | null;
  header: string;
  minutes: number;
  minutes2w: number;
  lastPlayed: number | null;
  platforms: { windows: number; mac: number; linux: number; deck: number };
  release: string | null;
  genres: string[];
  developer: string | null;
  metacritic: number | null;
  isFree: boolean;
  priceCents: number;
  tags: Tag[];
  reviews: { positive: number; negative: number } | null;
  medianMinutes: number | null;
  achievements: { total: number; unlocked: number; rarest: Rare[]; unlockTimes: number[] } | null;
}
export interface Pick {
  appid: number;
  name: string;
  header: string | null;
  short: string;
  developer: string | null;
  release: string | null;
  isFree: boolean;
  priceCents: number;
  fullPriceCents: number;
  discount: number;
  reviewPct: number | null;
  comingSoon?: boolean;
  reviews: number;
  ccu: number;
  owners: string;
  tags: string[];
  sharedTags: string[];
  because: { name: string; appid: number }[];
  wishlisted: boolean;
  /** Null when SteamSpy has no tags for the game yet (usually unreleased). */
  match: number | null;
  score: number;
}
export interface Snapshot {
  generatedAt: string;
  demo: boolean;
  currency: string;
  profile: {
    steamid: string;
    name: string;
    avatar: string | null;
    profileUrl: string;
    createdAt: number | null;
    level: number | null;
    xp: number | null;
    badges: number | null;
  };
  games: Game[];
  wishlist: { appid: number; addedAt: number; priority: number }[];
  picks: {
    profileTags: { tag: string; weight: number }[];
    tasteTags: string[];
    candidates: number;
    groups: { id: string; title: string; blurb: string; items: Pick[] }[];
  };
}

export const snapshot = snapshotJson as unknown as Snapshot;

// Formatting ------------------------------------------------------------------

export { num, compact, hours, money, pct, date } from './format';

export const yearOf = (release: string | null) => Number(release?.match(/\b(19|20)\d{2}\b/)?.[0]) || null;
export const storeUrl = (appid: number) => `https://store.steampowered.com/app/${appid}/`;
export const capsule = (appid: number) => `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/capsule_231x87.jpg`;

// Lower bound of the 95% interval on positive share (see scripts/sync-steam.mjs).
export function wilson(pos: number, neg: number) {
  const n = pos + neg;
  if (!n) return 0;
  const z = 1.96, p = pos / n;
  return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / (1 + (z * z) / n);
}

// Analytics -------------------------------------------------------------------

/** The library without software Steam lists alongside games (streaming tools, Source Filmmaker), most played first. */
export const steamGames = (s: Snapshot = snapshot) =>
  s.games.filter((g) => !g.genres.some((x) => SOFTWARE_GENRES.has(x))).sort((a, b) => b.minutes - a.minutes);

export function analyze(s: Snapshot = snapshot) {
  const games = steamGames(s);
  const played = games.filter((g) => g.minutes > 0);
  const totalMinutes = played.reduce((n, g) => n + g.minutes, 0);
  const now = new Date(s.generatedAt).getTime() / 1000;

  // Headline numbers
  const withAch = games.filter((g) => g.achievements?.total);
  const achUnlocked = withAch.reduce((n, g) => n + g.achievements!.unlocked, 0);
  const achTotal = withAch.reduce((n, g) => n + g.achievements!.total, 0);
  const perfect = withAch.filter((g) => g.achievements!.unlocked === g.achievements!.total);
  const paid = games.filter((g) => !g.isFree && g.priceCents > 0);
  const libraryValue = paid.reduce((n, g) => n + g.priceCents, 0);
  const paidHours = paid.reduce((n, g) => n + g.minutes, 0) / 60;
  const yearsOnSteam = s.profile.createdAt ? (now - s.profile.createdAt) / (365.25 * 86400) : null;

  const totals = {
    games: games.length,
    played: played.length,
    unplayed: games.length - played.length,
    totalMinutes,
    achUnlocked,
    achTotal,
    perfect,
    libraryValue,
    costPerHour: paidHours ? libraryValue / paidHours : 0,
    yearsOnSteam,
    avgPerDay: yearsOnSteam ? totalMinutes / (yearsOnSteam * 365.25) : null,
  };

  // Top games by playtime
  const top = played.slice(0, 15).map((g) => ({ ...g, share: g.minutes / totalMinutes }));

  // Where the hours went: #1 game, #2–5, #6–20, everything else
  const sum = (list: Game[]) => list.reduce((n, g) => n + g.minutes, 0);
  const concentration = [
    { key: 'first', label: played[0]?.name ?? 'Top game', minutes: sum(played.slice(0, 1)) },
    { key: 'next4', label: 'Games 2–5', minutes: sum(played.slice(1, 5)) },
    { key: 'next15', label: 'Games 6–20', minutes: sum(played.slice(5, 20)) },
    { key: 'rest', label: `The other ${Math.max(0, played.length - 20)}`, minutes: sum(played.slice(20)) },
  ].filter((c) => c.minutes > 0);

  // Taste: share of hours vs share of library, per tag (a game "has" a tag if it's in
  // its top 10). Format/vibe tags like "Singleplayer" are left out; they say little about taste.
  const tagged = games.filter((g) => g.tags.length);
  const tagStats = new Map<string, { minutes: number; count: number }>();
  for (const g of tagged)
    for (const t of g.tags.slice(0, 10)) {
      if (META_TAGS.has(t.name)) continue;
      const st = tagStats.get(t.name) ?? { minutes: 0, count: 0 };
      st.minutes += g.minutes;
      st.count += 1;
      tagStats.set(t.name, st);
    }
  const taggedMinutes = sum(tagged);
  const tags = [...tagStats]
    .map(([name, st]) => ({ name, hoursShare: st.minutes / (taggedMinutes || 1), libraryShare: st.count / (tagged.length || 1), count: st.count }))
    .sort((a, b) => b.hoursShare - a.hoursShare)
    .slice(0, 12);

  // Hours by release year
  const byYear = new Map<number, { minutes: number; count: number }>();
  for (const g of games) {
    const y = yearOf(g.release);
    if (!y) continue;
    const st = byYear.get(y) ?? { minutes: 0, count: 0 };
    st.minutes += g.minutes;
    st.count += 1;
    byYear.set(y, st);
  }
  const years = byYear.size ? [...byYear.keys()] : [];
  const releaseYears = years.length
    ? Array.from({ length: Math.max(...years) - Math.min(...years) + 1 }, (_, i) => {
        const year = Math.min(...years) + i;
        return { year, ...(byYear.get(year) ?? { minutes: 0, count: 0 }) };
      })
    : [];

  // Activity: achievement unlocks per month — the only dated play signal Steam exposes
  const unlockMonths = new Map<string, number>();
  for (const g of withAch)
    for (const t of g.achievements!.unlockTimes) {
      const d = new Date(t * 1000);
      const k = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
      unlockMonths.set(k, (unlockMonths.get(k) ?? 0) + 1);
    }
  const unlockYears = [...unlockMonths.keys()].map((k) => Number(k.split('-')[0]));
  const activity = unlockYears.length
    ? Array.from({ length: Math.max(...unlockYears) - Math.min(...unlockYears) + 1 }, (_, i) => {
        const year = Math.max(...unlockYears) - i;
        return { year, months: Array.from({ length: 12 }, (_, m) => unlockMonths.get(`${year}-${m}`) ?? 0) };
      })
    : [];
  const activityMax = Math.max(0, ...activity.flatMap((r) => r.months));

  // Platforms
  const platformTotals = { windows: 0, mac: 0, linux: 0, deck: 0 };
  for (const g of games) for (const k of Object.keys(platformTotals) as (keyof typeof platformTotals)[]) platformTotals[k] += g.platforms[k];
  const platforms = [
    { key: 'windows', label: 'Windows', minutes: platformTotals.windows },
    { key: 'deck', label: 'Steam Deck', minutes: platformTotals.deck },
    { key: 'mac', label: 'macOS', minutes: platformTotals.mac },
    { key: 'linux', label: 'Linux', minutes: platformTotals.linux },
  ].filter((p) => p.minutes > 0);

  const recent = games.filter((g) => g.minutes2w > 0).sort((a, b) => b.minutes2w - a.minutes2w);

  // Achievements
  const completion = withAch
    .filter((g) => g.minutes > 0)
    .slice(0, 12)
    .map((g) => ({ ...g, ratio: g.achievements!.unlocked / g.achievements!.total }));
  const rarest = withAch
    .flatMap((g) => g.achievements!.rarest.map((r) => ({ ...r, game: g.name, appid: g.appid })))
    .sort((a, b) => a.percent - b.percent)
    .slice(0, 8);

  // You vs the median owner, among the games you've put real time into
  const vsCrowd = played
    .slice(0, 30)
    .filter((g) => g.medianMinutes && g.minutes >= 120)
    .map((g) => ({ ...g, ratio: g.minutes / g.medianMinutes! }))
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 8);

  // Value
  const bestValue = paid
    .filter((g) => g.minutes >= 120)
    .map((g) => ({ ...g, perHour: g.priceCents / (g.minutes / 60) }))
    .sort((a, b) => a.perHour - b.perHour)
    .slice(0, 6);
  const untouched = paid
    .filter((g) => g.minutes < 30)
    .sort((a, b) => b.priceCents - a.priceCents)
    .slice(0, 6);
  const backlogGems = games
    .filter((g) => g.minutes < 60 && g.reviews && g.reviews.positive + g.reviews.negative >= 500)
    .map((g) => ({ ...g, reviewPct: g.reviews!.positive / (g.reviews!.positive + g.reviews!.negative), quality: wilson(g.reviews!.positive, g.reviews!.negative) }))
    .sort((a, b) => b.quality - a.quality)
    .slice(0, 8);

  // Dormancy: when each played game was last touched
  const lastPlayedYears = new Map<number, number>();
  for (const g of played) if (g.lastPlayed) {
    const y = new Date(g.lastPlayed * 1000).getUTCFullYear();
    lastPlayedYears.set(y, (lastPlayedYears.get(y) ?? 0) + 1);
  }

  return {
    totals,
    top,
    concentration,
    tags,
    releaseYears,
    activity,
    activityMax,
    platforms,
    recent,
    completion,
    rarest,
    vsCrowd,
    bestValue,
    untouched,
    backlogGems,
    lastPlayedYears: [...lastPlayedYears].sort((a, b) => a[0] - b[0]),
  };
}
