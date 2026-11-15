// Turns the Xbox snapshot (written by `npm run xbox:sync`) into the numbers the /games pages chart.
// Everything here runs at build time.
//
// What counts as an Xbox game here:
//  - PC-only titles are left out. Xbox's history includes games played through Steam and other
//    launchers, which Steam already reports with real hours. A title on a console (or Switch, mobile)
//    counts even if it also ships on PC.
//  - Betas and launchers are dropped.
//  - Play time is Xbox's own approximate MinutesPlayed stat, and plenty of games don't report it.
//    Those keep `tracked: false` and 0 minutes: "unknown", not "never played".
import snapshotJson from '../data/xbox/snapshot.json';
import storeJson from '../data/xbox/store.json';
import { normalizeTitle } from './psn';

export interface RawGame {
  titleId: string;
  name: string;
  devices: string[];
  image: string | null;
  /** null = Xbox reported nothing for this game. */
  minutes: number | null;
  lastPlayed: string | null;
  achievements: number;
  gamerscore: number;
  totalGamerscore: number;
  gamePass: boolean;
}
export interface Snapshot {
  generatedAt: string;
  profile: { gamertag: string | null; gamerscore: number; avatar: string | null };
  games: RawGame[];
}
export const snapshot = snapshotJson as unknown as Snapshot;

export interface Rating { avg: number; count: number }
/** A Game Pass game picked for you, from src/data/xbox/store.json. */
export interface StorePick {
  id: string;
  name: string;
  image: string | null;
  msrpCents: number | null;
  rating: Rating | null;
  release: string | null;
  genres: string[];
  sharedGenres: string[];
  because: string[];
  match: number;
}
export interface Store {
  generatedAt: string;
  catalog: number;
  profile: { genre: string; weight: number }[];
  candidates: number;
  groups: { id: string; title: string; blurb: string; items: StorePick[] }[];
  /** Catalog data for games in your history, keyed by title id. */
  owned: Record<string, { genres: string[]; rating: Rating | null; release: string | null; image: string | null; productId: string }>;
}
export const store = storeJson as unknown as Store;
export const productUrl = (productId: string) => `https://www.xbox.com/en-US/games/store/-/${productId}`;

const PC_DEVICES = new Set(['PC', 'Win32']);
const NOT_A_GAME = /\b(beta|launcher)\b/i;

/** True when the only platforms listed are PC ones. Titles with no device info are not assumed to be PC. */
export const isPcOnly = (devices: string[]) => devices.length > 0 && devices.every((d) => PC_DEVICES.has(d));

const isExcluded = (g: RawGame) => isPcOnly(g.devices) || NOT_A_GAME.test(g.name);

export interface Game {
  key: string;
  name: string;
  image: string | null;
  href: string | null;
  /** Wide 16:9 key art from the store catalog, for big cards. Null when the game isn't in the catalog. */
  banner: string | null;
  /** 0 when Xbox has no play time for it; check `tracked`. */
  minutes: number;
  tracked: boolean;
  lastPlayed: number | null;
  achievements: number;
  gamerscore: number;
  totalGamerscore: number;
  /** Share of the game's gamerscore earned, 0-100. Null when it has none to earn. */
  progress: number | null;
  gamePass: boolean;
  devices: string[];
  /** The store's genres, primary first. Empty when the game isn't in the catalog (older Xbox 360 titles). */
  genres: string[];
  rating: Rating | null;
  /** Every gamerscore point earned. */
  perfect: boolean;
}

/** The Microsoft store CDN resizes on request; the full-size art is hundreds of KB and nothing here needs it. */
const sized = (url: string | null) => (url && url.includes('s-microsoft.com') && !url.includes('?') ? `${url}?w=460&q=80` : url);

const toUnix = (iso: string | null) => (iso ? Math.floor(new Date(iso).getTime() / 1000) : null);

/** One row per game. A game can have several title ids (console and PC listings), so hours merge on the title. */
export function xboxGames(s: Snapshot = snapshot): Game[] {
  const groups = new Map<string, RawGame[]>();
  for (const g of s.games) {
    if (isExcluded(g)) continue;
    const key = normalizeTitle(g.name);
    groups.set(key, [...(groups.get(key) ?? []), g]);
  }

  return [...groups]
    .map(([key, raws]) => {
      const sorted = [...raws].sort((a, b) => (b.minutes ?? -1) - (a.minutes ?? -1));
      const lead = sorted[0];
      const lasts = raws.map((r) => toUnix(r.lastPlayed)).filter((x): x is number => x != null);
      const minutes = raws.reduce((n, r) => n + (r.minutes ?? 0), 0);
      const gamerscore = Math.max(...raws.map((r) => r.gamerscore));
      const totalGamerscore = Math.max(...raws.map((r) => r.totalGamerscore));
      const info = raws.map((r) => store.owned[r.titleId]).find(Boolean);
      return {
        key,
        name: lead.name.replace(/[™®©]/g, '').trim(),
        image: sized(raws.find((r) => r.image)?.image ?? info?.image ?? null),
        href: info ? productUrl(info.productId) : null,
        banner: info?.image ? info.image.replace(/([?&])w=\d+/, '$1w=1280') : null,
        minutes,
        tracked: raws.some((r) => r.minutes != null && r.minutes > 0),
        lastPlayed: lasts.length ? Math.max(...lasts) : null,
        achievements: Math.max(...raws.map((r) => r.achievements)),
        gamerscore,
        totalGamerscore,
        progress: totalGamerscore > 0 ? Math.min(100, Math.round((100 * gamerscore) / totalGamerscore)) : null,
        gamePass: raws.some((r) => r.gamePass),
        devices: [...new Set(raws.flatMap((r) => r.devices))],
        genres: info?.genres ?? [],
        rating: info?.rating ?? null,
        perfect: totalGamerscore > 0 && gamerscore >= totalGamerscore,
      } satisfies Game;
    })
    .sort((a, b) => b.minutes - a.minutes || (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0));
}

export function analyzeXbox(s: Snapshot = snapshot) {
  const games = xboxGames(s);
  const played = games.filter((g) => g.minutes > 0);
  const totalMinutes = played.reduce((n, g) => n + g.minutes, 0);
  const sum = (list: Game[]) => list.reduce((n, g) => n + g.minutes, 0);

  const top = played.slice(0, 15).map((g) => ({ ...g, share: g.minutes / totalMinutes }));
  const concentration = [
    { key: 'first', label: played[0]?.name ?? 'Top game', minutes: sum(played.slice(0, 1)) },
    { key: 'next4', label: 'Games 2–5', minutes: sum(played.slice(1, 5)) },
    { key: 'next15', label: 'Games 6–20', minutes: sum(played.slice(5, 20)) },
    { key: 'rest', label: `The other ${Math.max(0, played.length - 20)}`, minutes: sum(played.slice(20)) },
  ].filter((c) => c.minutes > 0);

  // Hours by each game's primary store genre. The catalog's genres are broad (about 15), so this is a rough cut.
  const byGenre = new Map<string, { minutes: number; games: number }>();
  for (const g of played) {
    const genre = g.genres[0];
    if (!genre) continue;
    const e = byGenre.get(genre) ?? { minutes: 0, games: 0 };
    e.minutes += g.minutes;
    e.games += 1;
    byGenre.set(genre, e);
  }
  const genres = [...byGenre].map(([genre, v]) => ({ genre, ...v })).sort((a, b) => b.minutes - a.minutes);

  // Game Pass membership as of the last sync: hours in games that are in the catalog today.
  const passMinutes = sum(played.filter((g) => g.gamePass));

  // Xbox records only when a game was last launched, never when it was first.
  const years = new Map<number, number>();
  for (const g of games) if (g.lastPlayed) {
    const y = new Date(g.lastPlayed * 1000).getUTCFullYear();
    years.set(y, (years.get(y) ?? 0) + 1);
  }
  const ys = [...years.keys()];
  const lastPlayedByYear = ys.length
    ? Array.from({ length: Math.max(...ys) - Math.min(...ys) + 1 }, (_, i) => ({ year: Math.min(...ys) + i, count: years.get(Math.min(...ys) + i) ?? 0 }))
    : [];

  const recent = games
    .filter((g) => g.lastPlayed != null && g.minutes > 0)
    .sort((a, b) => b.lastPlayed! - a.lastPlayed!)
    .slice(0, 8);

  // Achievements ---------------------------------------------------------------
  const withScore = games.filter((g) => g.progress != null);
  const completion = withScore.filter((g) => g.minutes > 0).slice(0, 12);
  const closest = withScore
    .filter((g) => !g.perfect && g.progress! >= 40)
    .sort((a, b) => b.progress! - a.progress!)
    .slice(0, 6);
  const perfect = games.filter((g) => g.perfect).sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0));

  return {
    totals: {
      games: games.length,
      played: played.length,
      /** In the history, but Xbox has no play time for them. */
      untracked: games.length - played.length,
      totalMinutes,
      achievements: games.reduce((n, g) => n + g.achievements, 0),
      gamerscore: s.profile.gamerscore,
      perfect: perfect.length,
      /** Titles dropped for being PC-only, betas or launchers. */
      excluded: s.games.filter(isExcluded).length,
    },
    top,
    concentration,
    genres,
    gamePass: { minutes: passMinutes, games: played.filter((g) => g.gamePass).length, tracked: sum(played) },
    lastPlayedByYear,
    recent,
    completion,
    closest,
    perfect,
  };
}
