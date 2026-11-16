// Steam + PlayStation + Xbox combined, for the /games overview. A game on several platforms
// becomes one row (matched on its normalized title) with the hours kept separate.
import { analyze, capsule, steamGames, storeUrl as steamStoreUrl, snapshot as steamSnapshot } from './steam';
import { analyzePsn, normalizeTitle, psnGames, snapshot as psnSnapshot } from './psn';
import { analyzeXbox, xboxGames } from './xbox';

export type Source = 'steam' | 'psn' | 'xbox';
export const sourceLabel: Record<Source, string> = { steam: 'Steam', psn: 'PlayStation', xbox: 'Xbox' };
export const sources: Source[] = ['steam', 'psn', 'xbox'];

export interface Entry {
  key: string;
  name: string;
  image: string | null;
  href: string;
  minutes: number;
  steam: { minutes: number } | null;
  psn: { minutes: number } | null;
  xbox: { minutes: number } | null;
  lastPlayed: number | null;
  /** Where the most recent session happened. */
  lastSource: Source | null;
}

const MIN_PLAUSIBLE = Date.UTC(2003, 0, 1) / 1000;

export function mergedGames(): Entry[] {
  const entries = new Map<string, Entry>();

  const touch = (key: string, init: () => Entry) => {
    let e = entries.get(key);
    if (!e) entries.set(key, (e = init()));
    return e;
  };
  // Steam reports a placeholder of 86400 (Jan 2, 1970) for some old games; anything before Steam existed is noise.
  const stamp = (e: Entry, source: Source, at: number | null) => {
    if (at && at > MIN_PLAUSIBLE && (!e.lastPlayed || at > e.lastPlayed)) {
      e.lastPlayed = at;
      e.lastSource = source;
    }
  };

  for (const g of steamGames()) {
    const e = touch(normalizeTitle(g.name), () => ({
      key: String(g.appid), name: g.name, image: capsule(g.appid), href: steamStoreUrl(g.appid),
      minutes: 0, steam: null, psn: null, xbox: null, lastPlayed: null, lastSource: null,
    }));
    e.steam = { minutes: g.minutes };
    e.minutes += g.minutes;
    stamp(e, 'steam', g.lastPlayed || null);
  }
  for (const g of psnGames()) {
    const e = touch(normalizeTitle(g.name), () => ({
      key: g.key, name: g.name, image: g.image, href: g.href ?? '',
      minutes: 0, steam: null, psn: null, xbox: null, lastPlayed: null, lastSource: null,
    }));
    e.psn = { minutes: g.minutes };
    if (g.minutes > (e.steam?.minutes ?? 0) && g.image) {
      e.image = g.image;
      if (g.href) e.href = g.href;
    }
    e.minutes += g.minutes;
    stamp(e, 'psn', g.lastPlayed);
  }
  for (const g of xboxGames()) {
    const e = touch(normalizeTitle(g.name), () => ({
      key: `xbox-${g.key}`, name: g.name, image: g.image, href: '',
      minutes: 0, steam: null, psn: null, xbox: null, lastPlayed: null, lastSource: null,
    }));
    e.xbox = { minutes: g.minutes };
    // Xbox art is only a fallback; Steam and PlayStation have better capsules.
    if (!e.image && g.image) e.image = g.image;
    e.minutes += g.minutes;
    stamp(e, 'xbox', g.lastPlayed);
  }
  return [...entries.values()].sort((a, b) => b.minutes - a.minutes);
}

export function analyzeAll() {
  const steam = analyze();
  const psn = analyzePsn();
  const xbox = analyzeXbox();
  const entries = mergedGames();
  const played = entries.filter((e) => e.minutes > 0);
  const totalMinutes = played.reduce((n, e) => n + e.minutes, 0);
  const steamMinutes = steam.totals.totalMinutes;
  const psnMinutes = psn.totals.totalMinutes;
  const xboxMinutes = xbox.totals.totalMinutes;

  const top = played.slice(0, 15).map((e) => ({ ...e, share: e.minutes / totalMinutes }));
  const topShare = (n: number) => played.slice(0, n).reduce((s, e) => s + e.minutes, 0) / (totalMinutes || 1);

  const platformCount = (e: Entry) => sources.filter((k) => e[k]).length;
  const multi = entries
    .filter((e) => platformCount(e) > 1 && e.minutes > 0)
    .slice(0, 8);

  // Colors on the overview are per platform (Steam, PlayStation, Xbox), so consoles aren't split further here.
  const platforms = [
    { key: 'steam' as const, label: sourceLabel.steam, minutes: steamMinutes },
    { key: 'psn' as const, label: sourceLabel.psn, minutes: psnMinutes },
    { key: 'xbox' as const, label: sourceLabel.xbox, minutes: xboxMinutes },
  ].filter((p) => p.minutes > 0);

  const lastYears = new Map<number, number>();
  for (const e of played) if (e.lastPlayed) {
    const y = new Date(e.lastPlayed * 1000).getUTCFullYear();
    lastYears.set(y, (lastYears.get(y) ?? 0) + 1);
  }
  const ys = [...lastYears.keys()];
  const lastPlayedByYear = ys.length
    ? Array.from({ length: Math.max(...ys) - Math.min(...ys) + 1 }, (_, i) => ({ year: Math.min(...ys) + i, count: lastYears.get(Math.min(...ys) + i) ?? 0 }))
    : [];

  const recent = played.filter((e) => e.lastPlayed).sort((a, b) => b.lastPlayed! - a.lastPlayed!).slice(0, 8);

  // Xbox has no first-played date, so it can't push this back.
  const since = [steamSnapshot.profile.createdAt, ...psnSnapshot.games.map((g) => g.firstPlayed && Math.floor(new Date(g.firstPlayed).getTime() / 1000))].filter((x): x is number => !!x);

  return {
    steam,
    psn,
    xbox,
    totals: {
      totalMinutes,
      steamMinutes,
      psnMinutes,
      xboxMinutes,
      games: entries.length,
      played: played.length,
      /** Never launched on any platform. Games in the Xbox history are left out: Xbox launched them but can't say for how long. */
      unplayed: entries.filter((e) => e.minutes === 0 && !e.xbox).length,
      unplayedSteam: steam.totals.unplayed,
      unplayedPsn: psn.totals.unplayed,
      multi: entries.filter((e) => platformCount(e) > 1).length,
      achievements: steam.totals.achUnlocked + psn.trophies.total + xbox.totals.achievements,
      steamAchievements: steam.totals.achTotal > 0,
      perfect: steam.totals.perfect.length + psn.trophies.earned.platinum + xbox.totals.perfect,
      since: since.length ? Math.min(...since) : null,
    },
    top,
    top1Share: top[0]?.share ?? 0,
    top5Share: topShare(5),
    platforms,
    multi,
    lastPlayedByYear,
    recent,
  };
}
