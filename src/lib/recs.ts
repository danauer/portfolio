// Everything the recommendations page shows: what to play from the library you already own
// (Steam + PlayStation), plus the Steam, PlayStation and Xbox (Game Pass) store picks, all reduced to one card shape.
import tagLists from '../data/steam/tags.json';
import { compact, hours, money, num } from './format';
import { capsule, snapshot as steamSnapshot, steamGames, storeUrl as steamStoreUrl, wilson, yearOf } from './steam';
import { normalizeTitle, productUrl, psnGames, store as psnStore } from './psn';
import { productUrl as xboxProductUrl, store as xboxStore, xboxGames } from './xbox';

const META_TAGS = new Set(tagLists.meta);

export type Source = 'steam' | 'psn' | 'xbox';
export interface Chip { text: string; shared?: boolean }
export interface Card {
  key: string;
  name: string;
  image: string | null;
  href: string;
  /** Which stores it's in (owned, for backlog cards; sold, for store picks). */
  sources: Source[];
  match: number | null;
  /** Review line, platform line or ownership line, shown at the left under the title. */
  left?: { text: string; dim?: boolean };
  priceText?: string;
  fullPriceText?: string;
  discount?: number;
  because?: string[];
  chips: Chip[];
  foot?: string;
  /** Large artwork to try for the big "feature" cards, best first. Resolved to `banner` / `poster` at build time by `withBanners`. */
  heroArt?: string[];
  /** Portrait (2:3) artwork to try first, where a store has any. */
  posterArt?: string[];
  banner?: string | null;
  poster?: string | null;
  /** Games you've played that this one is most like, with what they share. */
  related?: Related[];
}
export interface Related { name: string; minutes: number; /** Tags or genres the two have in common. */ shared: string[] }
export interface CardGroup { id: string; title: string; blurb: string; items: Card[] }

/** The PlayStation CDN resizes on request; card art never needs to be bigger than this. */
const sized = (url: string | null) => (url ? `${url}${url.includes('?') ? '&' : '?'}w=460` : null);

/** "Call of Duty: Black Ops 6" and "Call of Duty: Modern Warfare 4" are one series; show one of them. */
const franchise = (name: string) =>
  normalizeTitle(name.split(/[:\-–—]\s/)[0])
    .replace(/\s+(\d+|[ivx]+)$/, '')
    .trim();

// Backlog ---------------------------------------------------------------------

/** Taste profiles are built from games with at least this long played. */
const PROFILE_MINUTES = 60;
/** "Pick up where you left off" covers a minute up to this much, summed across every platform. */
export const STARTED_MAX_MINUTES = 5 * 60;
/** Steam reports a placeholder of 86400 (Jan 2, 1970) for some old games; anything before Steam existed is noise. */
const MIN_PLAUSIBLE = Date.UTC(2003, 0, 1) / 1000;

type Tags = { name: string; votes: number }[];
const tagVector = (tags: Tags) => {
  const max = tags[0]?.votes || 1;
  return new Map(tags.map((t) => [t.name, t.votes / max]));
};
function cosine(a: Map<string, number>, b: Map<string, number>, idf: Map<string, number>) {
  let dot = 0, na = 0, nb = 0;
  for (const [t, v] of a) {
    const w = v * (idf.get(t) ?? 1);
    na += w * w;
    if (b.has(t)) dot += w * b.get(t)! * (idf.get(t) ?? 1);
  }
  for (const [t, v] of b) nb += (v * (idf.get(t) ?? 1)) ** 2;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
const minMax = (values: number[]) => {
  const lo = Math.min(...values), hi = Math.max(...values);
  return (v: number) => (hi > lo ? (v - lo) / (hi - lo) : 0);
};

/** Overlap of two genre lists, 0-1 (cosine on binary vectors). */
const genreSimilarity = (a: string[], b: string[]) => {
  if (!a.length || !b.length) return 0;
  const set = new Set(b);
  return a.filter((x) => set.has(x)).length / Math.sqrt(a.length * b.length);
};

/**
 * The played games a candidate is most like: the closest matches above `min`, favoring ones you spent longer in,
 * one per franchise, at most three. (Same-series games count: "Fallout 3" is a fair reason to suggest "Fallout 4".)
 */
function pickRelated(played: { name: string; minutes: number; sim: number; shared: string[] }[], self: string, min: number): Related[] {
  const seen = new Set<string>();
  const out: Related[] = [];
  const ranked = played
    .filter((x) => x.sim >= min && normalizeTitle(x.name) !== normalizeTitle(self))
    .sort((a, b) => b.sim * Math.log1p(b.minutes / 60) - a.sim * Math.log1p(a.minutes / 60));
  for (const x of ranked) {
    const f = franchise(x.name);
    if (seen.has(f)) continue;
    seen.add(f);
    out.push({ name: x.name, minutes: x.minutes, shared: x.shared });
    if (out.length === 3) break;
  }
  return out;
}

interface Candidate extends Card {
  score: number;
  /** The platform this card was built from. A merged card keeps its home platform's data. */
  home: Source;
  /** Total minutes across every platform. */
  minutes: number;
  lastPlayed: number | null;
  /** Foot-line facts besides play time: price, year, Game Pass. */
  extra: string[];
}

/** "Lake Demo", "TUNIC SGDemo" (but not "Demon's Souls"). */
const isDemo = (name: string) => /(^|[^a-z])demo$|\bdemo\b|[a-z]demo\b/i.test(name);

const SOURCES: Source[] = ['steam', 'psn', 'xbox'];
export const platformName: Record<Source, string> = { steam: 'Steam', psn: 'PlayStation', xbox: 'Xbox' };

/** One card for a game owned on several platforms: the higher-scoring platform's card, with every platform listed. */
function mergeCards(a: Candidate, b: Candidate): Candidate {
  const base = a.score >= b.score ? a : b;
  return {
    ...base,
    sources: SOURCES.filter((s) => a.sources.includes(s) || b.sources.includes(s)),
    score: Math.max(a.score, b.score),
    lastPlayed: Math.max(a.lastPlayed ?? 0, b.lastPlayed ?? 0) || null,
  };
}

/** Candidate -> card. The foot line is built here, from the game's total time, so a merged card never says "Never launched" when another platform has hours. */
const strip = ({ score, home, minutes, lastPlayed, extra, ...card }: Candidate): Card => {
  const played = minutes > 0 ? [`${hours(minutes)} played`, lastPlayed ? `last ${new Date(lastPlayed * 1000).getUTCFullYear()}` : null] : ['Never launched'];
  const also = card.sources.filter((s) => s !== home).map((s) => platformName[s]);
  return { ...card, foot: [...played, ...extra, also.length ? `Also on ${also.join(' and ')}` : null].filter(Boolean).join(' · ') };
};

/** The first `n` of `list`, one per franchise, skipping franchises in `skip`. */
function take(list: Candidate[], n: number, skip = new Set<string>()) {
  const used = new Set(skip);
  const out: Candidate[] = [];
  for (const c of list) {
    if (out.length === n) break;
    const f = `f:${franchise(c.name)}`;
    if (used.has(f)) continue;
    out.push(c);
    used.add(f);
  }
  return out;
}

/**
 * Scores aren't comparable across platforms (Steam leans on review data and has far more games), so one shared
 * ranking would bury the others. Each platform is ranked on its own, then the lists are interleaved (best of each first).
 */
function interleave(list: Candidate[]) {
  const rank = new Map<Candidate, number>();
  for (const source of SOURCES)
    list
      .filter((c) => c.sources.includes(source))
      .sort((a, b) => b.score - a.score)
      .forEach((c, i) => rank.set(c, Math.min(rank.get(c) ?? Infinity, i)));
  return [...list].sort((a, b) => rank.get(a)! - rank.get(b)! || b.score - a.score);
}

/** An "All" tab (best of each platform) plus one tab per platform that has anything, 12 cards each. */
function tabsFor(prefix: string, ranked: Candidate[], rest: Candidate[], blurbs: Record<'all' | Source, string>, skip = new Set<string>()) {
  const on = (source: Source) => rest.filter((c) => c.sources.includes(source)).sort((a, b) => b.score - a.score);
  const count = (source: Source) => ranked.filter((c) => c.sources.includes(source)).length;
  const tab = (key: 'all' | Source, label: string, list: Candidate[], n: number) => ({
    key,
    label,
    count: n,
    groups: [{ id: `${prefix}-${key}`, title: '', blurb: blurbs[key], items: take(list, 12, skip).map(strip) }] satisfies CardGroup[],
  });
  return {
    tabs: [tab('all', 'All', rest, ranked.length), tab('steam', 'Steam', on('steam'), count('steam')), tab('psn', 'PlayStation', on('psn'), count('psn')), tab('xbox', 'Xbox', on('xbox'), count('xbox'))].filter(
      (t) => t.key === 'all' || t.groups[0].items.length > 0,
    ),
    counts: { steam: count('steam'), psn: count('psn'), xbox: count('xbox'), total: ranked.length },
  };
}

/**
 * Games you own, in two piles: ones with no time at all on any platform ("unplayed": three to start with plus tabs),
 * and ones with a minute to five hours across platforms ("started": tabs), each ranked by fit and quality.
 *  - Steam: Steam user tags matched against the tags of what you've played (weighted by hours),
 *    blended with review confidence.
 *  - PlayStation: genre fit from the PlayStation Store (see scripts/sync-psn.mjs). The store has no
 *    review scores, so quality counts as average there.
 *  - Xbox: it can't list games you own but never opened, so it only has started games: genre fit from the Xbox store
 *    blended with its user ratings. Games in your Xbox history with no recorded time are in neither pile (launched, duration unknown).
 * A game on several platforms appears once; one with more than five hours in total is left out of both.
 */
export function backlog() {
  const steam = steamGames();
  const psn = psnGames();
  const xbox = xboxGames();

  // Minutes by title across all platforms (Xbox included).
  const minutesByTitle = new Map<string, number>();
  for (const g of [...steam, ...psn, ...xbox]) minutesByTitle.set(normalizeTitle(g.name), (minutesByTitle.get(normalizeTitle(g.name)) ?? 0) + g.minutes);
  const total = (name: string) => minutesByTitle.get(normalizeTitle(name)) ?? 0;
  const xboxSeen = new Set(xbox.map((g) => normalizeTitle(g.name)));
  // Eligible: five hours or less in total, and not something Xbox says you launched but can't say for how long.
  const eligible = (name: string) => total(name) <= STARTED_MAX_MINUTES && !(total(name) === 0 && xboxSeen.has(normalizeTitle(name)));

  // Steam taste profile: tags of every game with an hour or more, weighted by sqrt(hours).
  const df = new Map<string, number>();
  for (const g of steam) g.tags.forEach((t) => df.set(t.name, (df.get(t.name) ?? 0) + 1));
  const idf = new Map([...df].map(([t, n]) => [t, Math.log((steam.length + 1) / (n + 1)) + 1]));
  const profile = new Map<string, number>();
  for (const g of steam.filter((x) => x.minutes >= PROFILE_MINUTES && x.tags.length)) {
    const w = Math.sqrt(g.minutes / 60);
    for (const [t, v] of tagVector(g.tags)) profile.set(t, (profile.get(t) ?? 0) + w * v);
  }

  const steamCands = steam.filter((g) => g.tags.length && eligible(g.name));
  const affinity = steamCands.map((g) => cosine(profile, tagVector(g.tags), idf));
  const quality = steamCands.map((g) => (g.reviews && g.reviews.positive + g.reviews.negative >= 50 ? wilson(g.reviews.positive, g.reviews.negative) : null));
  const nA = minMax(affinity);
  const nQ = minMax(quality.filter((q): q is number => q != null));
  const playedSteam = steam.filter((x) => x.minutes >= PROFILE_MINUTES && x.tags.length).map((x) => ({ game: x, vec: tagVector(x.tags) }));

  const cards = new Map<string, Candidate>();
  const add = (card: Candidate) => {
    const key = normalizeTitle(card.name);
    const other = cards.get(key);
    cards.set(key, other ? mergeCards(other, card) : card);
  };

  steamCands.forEach((g, i) => {
    const reviews = g.reviews ? g.reviews.positive + g.reviews.negative : 0;
    const shared = [...tagVector(g.tags)]
      .filter(([t]) => profile.has(t) && !META_TAGS.has(t))
      .map(([t, v]) => [t, v * profile.get(t)! * idf.get(t)! ** 2] as const)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([t]) => t);
    add({
      key: `steam-${g.appid}`,
      name: g.name,
      image: g.header || capsule(g.appid),
      href: steamStoreUrl(g.appid),
      sources: ['steam'],
      home: 'steam',
      match: Math.round(100 * nA(affinity[i])),
      left: g.reviews && reviews >= 50
        ? { text: `${Math.round((100 * g.reviews.positive) / reviews)}% positive (${compact(reviews)})` }
        : { text: 'Few reviews', dim: true },
      chips: [
        ...shared.map((text) => ({ text, shared: true })),
        ...g.tags.filter((t) => !shared.includes(t.name) && !META_TAGS.has(t.name)).slice(0, Math.max(0, 4 - shared.length)).map((t) => ({ text: t.name })),
      ],
      // library_hero is a 1920x620 panorama most games have; older ones only have the 616x353 capsule.
      heroArt: [`https://cdn.akamai.steamstatic.com/steam/apps/${g.appid}/library_hero.jpg`, `https://cdn.akamai.steamstatic.com/steam/apps/${g.appid}/capsule_616x353.jpg`],
      // 600x900 is the 2:3 poster; the unsuffixed one is only 300x450.
      posterArt: [`https://cdn.akamai.steamstatic.com/steam/apps/${g.appid}/library_600x900_2x.jpg`, `https://cdn.akamai.steamstatic.com/steam/apps/${g.appid}/library_600x900.jpg`],
      related: pickRelated(
        playedSteam.map(({ game, vec }) => ({
          name: game.name,
          minutes: game.minutes,
          sim: cosine(tagVector(g.tags), vec, idf),
          shared: g.tags.filter((t) => game.tags.some((u) => u.name === t.name) && !META_TAGS.has(t.name)).slice(0, 2).map((t) => t.name),
        })),
        g.name,
        0.3,
      ),
      minutes: total(g.name),
      lastPlayed: g.lastPlayed && g.lastPlayed > MIN_PLAUSIBLE ? g.lastPlayed : null,
      extra: [g.isFree ? 'Free' : g.priceCents ? `${money(g.priceCents, 2)} list price` : null, yearOf(g.release)].filter((x): x is string => !!x),
      score: 0.65 * nA(affinity[i]) + 0.35 * (quality[i] == null ? 0.5 : nQ(quality[i]!)),
    });
  });

  const playedPsn = psn
    .filter((x) => x.minutes >= PROFILE_MINUTES)
    .map((x) => ({ name: x.name, minutes: x.minutes, genres: x.titleIds.map((id) => psnStore.owned[id]?.genres).find((gs) => gs?.length) ?? [] }))
    .filter((x) => x.genres.length);
  for (const g of psn.filter((x) => eligible(x.name))) {
    const fit = g.titleIds.map((id) => psnStore.owned[id]).filter(Boolean);
    const match = fit.map((f) => f.match).filter((m): m is number => m != null).sort((a, b) => b - a)[0];
    if (match == null) continue; // not in the store catalog, so nothing to match on
    const genres = fit.find((f) => f.genres.length)?.genres ?? [];
    add({
      key: `psn-${g.key}`,
      name: g.name,
      image: sized(g.image),
      href: g.href ?? '',
      sources: ['psn'],
      home: 'psn',
      match,
      left: g.membership === 'PS_PLUS' ? { text: 'PS Plus claim', dim: false } : { text: 'Purchased', dim: false },
      chips: genres.map((text) => ({ text })),
      // Catalog art is 1920x1080 and resizes on request; the fallback icons (icon0.png) are square and too small.
      heroArt: g.image && g.image.includes('/cdn/') ? [`${g.image}${g.image.includes('?') ? '&' : '?'}w=1280`] : [],
      related: pickRelated(
        playedPsn.map((x) => ({ name: x.name, minutes: x.minutes, sim: genreSimilarity(genres, x.genres), shared: genres.filter((y) => x.genres.includes(y)).slice(0, 2) })),
        g.name,
        0.5,
      ),
      minutes: total(g.name),
      lastPlayed: g.lastPlayed,
      extra: [],
      score: 0.65 * (match / 100) + 0.35 * 0.5,
    });
  }

  // Shrink ratings toward 4.0 so a few ratings can't beat tens of thousands. Below 3.7 a game is poorly rated
  // however well it fits (same floor as the Game Pass picks in scripts/sync-xbox.mjs).
  const shrunkRating = (r: { avg: number; count: number } | null) => (r ? (r.avg * r.count + 4 * 50) / (r.count + 50) : null);
  const xboxCands = xbox.filter((g) => g.minutes > 0 && g.genres.length && !isDemo(g.name) && eligible(g.name) && (shrunkRating(g.rating) ?? 4) >= 3.7);
  const xboxProfile = new Map(xboxStore.profile.map((p) => [p.genre, p.weight]));
  const xboxAffinity = xboxCands.map((g) => cosine(xboxProfile, new Map(g.genres.map((x) => [x, 1])), new Map()));
  const xboxQuality = xboxCands.map((g) => shrunkRating(g.rating));
  const playedXbox = xbox.filter((g) => g.minutes >= PROFILE_MINUTES && g.genres.length);
  const xA = minMax(xboxAffinity);
  const xQ = minMax(xboxQuality.filter((q): q is number => q != null));
  xboxCands.forEach((g, i) =>
    add({
      key: `xbox-${g.key}`,
      name: g.name,
      image: g.image,
      href: g.href ?? '',
      sources: ['xbox'],
      home: 'xbox',
      match: Math.round(100 * xA(xboxAffinity[i])),
      left: g.rating ? { text: `${g.rating.avg.toFixed(1)} / 5 (${compact(g.rating.count)} ratings)` } : { text: 'Not rated yet', dim: true },
      chips: g.genres.slice(0, 4).map((text) => ({ text })),
      heroArt: g.banner ? [g.banner] : [],
      related: pickRelated(
        playedXbox.map((x) => ({ name: x.name, minutes: x.minutes, sim: genreSimilarity(g.genres, x.genres), shared: g.genres.filter((y) => x.genres.includes(y)).slice(0, 2) })),
        g.name,
        0.5,
      ),
      minutes: total(g.name),
      lastPlayed: g.lastPlayed,
      extra: g.gamePass ? ['On Game Pass'] : [],
      score: 0.65 * xA(xboxAffinity[i]) + 0.35 * (xboxQuality[i] == null ? 0.5 : xQ(xboxQuality[i]!)),
    }),
  );

  const all = [...cards.values()];
  const unplayed = interleave(all.filter((c) => c.minutes === 0));
  const started = interleave(all.filter((c) => c.minutes > 0));

  // Three to start with, from whichever platforms rank best. A platform with a tiny pool gets a 100% match for its best
  // one however mediocre it is, so the headline picks must clear a bar first; if too few do, the bar is dropped.
  // The tabs below skip these and their franchises.
  // They're shown large, so they also need real artwork (some PlayStation games only have a small square icon).
  const withArt = unplayed.filter((c) => (c.heroArt?.length ?? 0) > 0);
  const strong = withArt.filter((c) => c.score >= 0.75);
  const hero = take(strong.length >= 3 ? strong : withArt.length >= 3 ? withArt : unplayed, 3);
  const heroSeries = new Set(hero.map((c) => `f:${franchise(c.name)}`));

  const unplayedTabs = tabsFor(
    'library',
    unplayed,
    unplayed.filter((c) => !hero.some((h) => h.key === c.key)),
    {
      all: 'The best of each library side by side. Each platform is ranked on its own, by how well a game fits what you actually play and, on Steam, how well it was received. A game on more than one platform shows once.',
      steam: 'Steam games you’ve never launched, ranked by tag fit and review confidence.',
      psn: 'Purchases and PS Plus claims you haven’t launched, matched on genre. PS Plus claims are only playable while you’re subscribed.',
      xbox: '',
    },
    heroSeries,
  );
  const startedTabs = tabsFor('resume', started, started, {
    all: 'Games with a minute to five hours on the clock, counting every platform together. Ranked the same way: fit with what you play, plus reviews or ratings where the store has them.',
    steam: 'Steam games with up to five hours played, ranked by tag fit and review confidence.',
    psn: 'PlayStation games you’ve launched but not stuck with (up to five hours), matched on genre.',
    xbox: 'Xbox games with up to five hours on record, matched on genre and the store’s user ratings. Xbox play time is approximate, and games that report none aren’t included.',
  });

  return { hero: hero.map(strip), ...unplayedTabs, resume: startedTabs };
}

/**
 * Picks the first artwork in each card's `heroArt` that actually exists (Steam doesn't have every size for every game),
 * checked with a HEAD request at build time. If none respond, the card keeps its normal image.
 */
export async function withBanners(cards: Card[]): Promise<Card[]> {
  const firstThatExists = async (urls: string[] = []) => {
    for (const url of urls) {
      try {
        const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
        if (res.ok && res.headers.get('content-type')?.startsWith('image/')) return url;
      } catch {
        // offline or slow: try the next one
      }
    }
    return null;
  };
  return Promise.all(cards.map(async (card) => ({ ...card, banner: await firstThatExists(card.heroArt), poster: await firstThatExists(card.posterArt) })));
}

// Store picks -------------------------------------------------------------------

export function steamStoreGroups(): CardGroup[] {
  return steamSnapshot.picks.groups.map((group) => ({
    id: `steam-${group.id}`,
    title: group.title,
    blurb: group.blurb,
    items: group.items.map((p): Card => ({
      key: `steam-store-${p.appid}`,
      name: p.name,
      image: p.header,
      href: steamStoreUrl(p.appid),
      sources: ['steam'],
      match: p.match,
      left: p.comingSoon ? { text: 'Coming soon' } : p.reviewPct == null ? { text: 'No reviews yet', dim: true } : { text: `${p.reviewPct}% positive (${compact(p.reviews)})` },
      priceText: p.isFree ? 'Free to play' : p.priceCents ? money(p.priceCents, 2) : '—',
      fullPriceText: p.discount > 0 ? money(p.fullPriceCents, 2) : undefined,
      discount: p.discount,
      because: p.because.map((b) => b.name),
      chips: [
        ...p.sharedTags.map((text) => ({ text, shared: true })),
        ...p.tags.filter((t) => !p.sharedTags.includes(t)).slice(0, Math.max(0, 4 - p.sharedTags.length)).map((text) => ({ text })),
      ],
      foot: [p.developer, yearOf(p.release), p.ccu ? `${compact(p.ccu)} playing yesterday` : null, p.wishlisted ? 'On your wishlist' : null].filter(Boolean).join(' · '),
    })),
  }));
}

export function psnStoreGroups(): CardGroup[] {
  return psnStore.groups.map((group) => ({
    id: `psn-${group.id}`,
    title: group.title,
    blurb: group.blurb,
    items: group.items.map((p): Card => ({
      key: `psn-store-${p.id}`,
      name: p.name,
      image: sized(p.image),
      href: productUrl(p.id),
      sources: ['psn'],
      match: p.match,
      left: { text: p.platforms.join(' · ') || 'PlayStation', dim: true },
      priceText: p.isFree ? 'Free' : p.priceCents ? money(p.priceCents, 2) : '—',
      fullPriceText: p.discount > 0 ? money(p.fullPriceCents, 2) : undefined,
      discount: p.discount,
      because: p.because,
      chips: [
        ...p.sharedGenres.map((text) => ({ text, shared: true })),
        ...p.genres.filter((g) => !p.sharedGenres.includes(g)).slice(0, Math.max(0, 4 - p.sharedGenres.length)).map((text) => ({ text })),
      ],
      foot: [p.rank != null && p.rank < 150 ? `Store best seller #${num(p.rank + 1)}` : null, p.plusOnly ? 'PS Plus price' : null].filter(Boolean).join(' · '),
    })),
  }));
}

export function xboxStoreGroups(): CardGroup[] {
  return xboxStore.groups.map((group) => ({
    id: `xbox-${group.id}`,
    title: group.title,
    blurb: group.blurb,
    items: group.items.map((p): Card => ({
      key: `xbox-store-${p.id}`,
      name: p.name,
      image: p.image,
      href: xboxProductUrl(p.id),
      sources: ['xbox'],
      match: p.match,
      left: p.rating
        ? { text: `${p.rating.avg.toFixed(1)} / 5 (${compact(p.rating.count)} ratings)` }
        : { text: 'Not rated yet', dim: true },
      priceText: 'Game Pass',
      because: p.because,
      chips: [
        ...p.sharedGenres.map((text) => ({ text, shared: true })),
        ...p.genres.filter((g) => !p.sharedGenres.includes(g)).slice(0, Math.max(0, 4 - p.sharedGenres.length)).map((text) => ({ text })),
      ],
      foot: [p.release ? String(new Date(p.release).getUTCFullYear()) : null, p.msrpCents ? `${money(p.msrpCents, 2)} to buy` : null].filter(Boolean).join(' · '),
    })),
  }));
}

// New games --------------------------------------------------------------------

/**
 * Games you don't own, as tabs: every store's picks together, then each store's own groups (built by the sync scripts).
 * "All" interleaves the stores' best matches (best of each first, since match scores are only comparable within a store)
 * and adds what's on sale across the stores that have sales. A game sold on several stores shows once.
 */
export function newGames() {
  const steam = steamStoreGroups();
  const psn = psnStoreGroups();
  const xbox = xboxStoreGroups();
  const best = (groups: CardGroup[]) => groups.find((g) => g.id.endsWith('-best'))?.items ?? [];

  // Round-robin: Steam #1, PlayStation #1, Xbox #1, Steam #2, ...
  const lists = [best(steam), best(psn), best(xbox)];
  const interleaved: Card[] = [];
  for (let i = 0; i < Math.max(...lists.map((l) => l.length)); i++) for (const l of lists) if (l[i]) interleaved.push(l[i]);

  const merged = new Map<string, Card>();
  for (const c of interleaved) {
    const k = normalizeTitle(c.name);
    const prev = merged.get(k);
    merged.set(k, prev ? { ...prev, sources: SOURCES.filter((s) => prev.sources.includes(s) || c.sources.includes(s)) } : c);
  }
  const used = new Set<string>();
  const distinct = (cards: Card[], n: number) => {
    const out: Card[] = [];
    for (const c of cards) {
      const f = franchise(c.name);
      if (out.length === n || used.has(f)) continue;
      out.push(c);
      used.add(f);
    }
    return out;
  };
  const top = distinct([...merged.values()], 15);

  // Sales: Steam and PlayStation only (Game Pass has no price).
  const sale = new Map<string, Card>();
  for (const c of [...steam, ...psn].flatMap((g) => g.items).filter((c) => (c.discount ?? 0) >= 25 && (c.match ?? 0) >= 40).sort((a, b) => (b.match ?? 0) - (a.match ?? 0)))
    if (!sale.has(normalizeTitle(c.name))) sale.set(normalizeTitle(c.name), c);
  used.clear();
  const onSale = distinct([...sale.values()], 8);

  const all: CardGroup[] = [
    { id: 'new-all-best', title: '', blurb: 'The closest fits from each store, side by side. Match scores are only comparable within one store, so the stores take turns; a game sold on more than one shows once.', items: top },
    ...(onSale.length >= 3 ? [{ id: 'new-all-sale', title: 'On sale now', blurb: 'Discounted at least 25% on Steam or PlayStation, ranked by fit.', items: onSale }] : []),
  ];
  return { all, steam, psn, xbox };
}
