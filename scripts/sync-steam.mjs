#!/usr/bin/env node
// Pulls a Steam account's library, playtime and achievements, enriches each game
// with store + SteamSpy metadata, scores popular games you don't own against your
// taste, and writes one snapshot (src/data/steam/snapshot.json) that the /steam
// pages render at build time. The site stays fully static: the API key is only
// used here, locally, and never reaches the browser.
//
//   npm run steam:sync                # uses STEAM_API_KEY + STEAM_ID from .env
//   npm run steam:sync -- --demo      # no key needed: a made-up library of real games
//   npm run steam:sync -- --refresh   # ignore the metadata cache
//
// STEAM_ID can be a 17-digit SteamID64 or a custom profile name (steamcommunity.com/id/<name>).
// Your profile's "Game details" privacy setting must be Public for owned games to come back.
//
// Store and SteamSpy responses are cached in .cache/steam for a week, so re-runs
// only hit the network for what's new. The first run on a big library takes a while
// (the store API allows ~200 requests per 5 minutes).
import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import tagLists from '../src/data/steam/tags.json' with { type: 'json' };

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'src/data/steam/snapshot.json');
const CACHE_DIR = path.join(ROOT, '.cache/steam');
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const TOP_TAGS = 15; // tags per game used for matching

const { values: opts } = parseArgs({
  options: {
    demo: { type: 'boolean', default: false },
    refresh: { type: 'boolean', default: false },
  },
});

const key = process.env.STEAM_API_KEY;
const idInput = process.env.STEAM_ID;
if (!opts.demo && (!key || !idInput)) {
  console.error('Set STEAM_API_KEY and STEAM_ID in .env (key: https://steamcommunity.com/dev/apikey), or run with --demo.');
  process.exit(1);
}

// HTTP ------------------------------------------------------------------------

// One queue per host, so each API's rate limit is respected independently while
// the hosts are fetched in parallel.
const hostGap = {
  'api.steampowered.com': 120,
  'store.steampowered.com': 1600,
  'steamspy.com': 1100,
};
const hostQueue = new Map();
function throttled(host, fn) {
  const prev = hostQueue.get(host) ?? Promise.resolve();
  const run = prev.then(fn);
  hostQueue.set(host, run.then(() => sleep(hostGap[host] ?? 250), () => sleep(hostGap[host] ?? 250)));
  return run;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, { retries = 3 } = {}) {
  const { host } = new URL(url);
  return throttled(host, async () => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers: { 'User-Agent': 'portfolio-steam-sync/1.0' } });
      if (res.ok) {
        const text = await res.text();
        return text ? JSON.parse(text) : null;
      }
      // 429 from the store means "slow down for a minute or so".
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const wait = res.status === 429 ? 65_000 : 3_000 * (attempt + 1);
        console.warn(`  ${res.status} from ${host}, waiting ${Math.round(wait / 1000)}s…`);
        await sleep(wait);
        continue;
      }
      const err = new Error(`${res.status} ${url.replace(/key=[^&]+/, 'key=…')}`);
      err.status = res.status;
      throw err;
    }
  });
}

async function cached(name, ttl, fetcher) {
  const file = path.join(CACHE_DIR, `${name}.json`);
  if (!opts.refresh) {
    try {
      const { at, data } = JSON.parse(await readFile(file, 'utf8'));
      if (Date.now() - at < ttl) return data;
    } catch {}
  }
  const data = await fetcher();
  await writeFile(file, JSON.stringify({ at: Date.now(), data }));
  return data;
}

const api = (iface, method, version, params) => {
  const qs = new URLSearchParams({ ...(key ? { key } : {}), ...params });
  return getJson(`https://api.steampowered.com/${iface}/${method}/v${version}/?${qs}`);
};

// Metadata (no key needed) ----------------------------------------------------

async function storeDetails(appid) {
  return cached(`store-${appid}`, CACHE_TTL, async () => {
    try {
      const json = await getJson(`https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us&l=english`);
      const entry = json?.[appid];
      if (!entry?.success) return null;
      const d = entry.data;
      return {
        type: d.type,
        name: d.name,
        isFree: d.is_free,
        short: d.short_description,
        developers: d.developers ?? [],
        genres: (d.genres ?? []).map((g) => g.description),
        release: d.release_date?.date ?? null,
        comingSoon: d.release_date?.coming_soon ?? false,
        metacritic: d.metacritic?.score ?? null,
        header: d.header_image ?? null,
        price: d.price_overview ? { final: d.price_overview.final, initial: d.price_overview.initial, discount: d.price_overview.discount_percent } : null,
        adult: (d.content_descriptors?.ids ?? []).some((id) => id === 3 || id === 4),
      };
    } catch (err) {
      console.warn(`  store ${appid}: ${err.message}`);
      return null;
    }
  });
}

async function spyDetails(appid) {
  return cached(`spy-${appid}`, CACHE_TTL, async () => {
    try {
      const d = await getJson(`https://steamspy.com/api.php?request=appdetails&appid=${appid}`);
      if (!d?.name) return null;
      const tags = Object.entries(d.tags && !Array.isArray(d.tags) ? d.tags : {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_TAGS)
        .map(([name, votes]) => ({ name, votes }));
      return {
        tags,
        positive: d.positive,
        negative: d.negative,
        medianMinutes: d.median_forever,
        owners: d.owners,
        ccu: d.ccu,
        priceCents: Number(d.price) || 0,
        discount: Number(d.discount) || 0,
      };
    } catch (err) {
      console.warn(`  steamspy ${appid}: ${err.message}`);
      return null;
    }
  });
}

const spyList = (request, extra = '') =>
  cached(`spylist-${request}${extra.replace(/\W+/g, '-')}`, 2 * 24 * 60 * 60 * 1000, () =>
    getJson(`https://steamspy.com/api.php?request=${request}${extra}`),
  ).then((d) => Object.values(d ?? {}));

async function enrich(appids, label) {
  let done = 0;
  const out = new Map();
  await Promise.all(
    appids.map(async (appid) => {
      const [store, spy] = await Promise.all([storeDetails(appid), spyDetails(appid)]);
      out.set(appid, { store, spy });
      if (++done % 25 === 0 || done === appids.length) console.log(`  ${label}: ${done}/${appids.length}`);
    }),
  );
  return out;
}

// Account data (needs key) ----------------------------------------------------

async function resolveSteamId(input) {
  if (/^\d{17}$/.test(input)) return input;
  const vanity = input.replace(/^.*\/id\//, '').replace(/\/$/, '');
  const { response } = await api('ISteamUser', 'ResolveVanityURL', 1, { vanityurl: vanity });
  if (response.success !== 1) throw new Error(`Couldn't resolve Steam profile "${input}"`);
  return response.steamid;
}

async function fetchAccount(steamid) {
  console.log('Fetching profile and library…');
  const [summary, badges, owned, wishlist] = await Promise.all([
    api('ISteamUser', 'GetPlayerSummaries', 2, { steamids: steamid }),
    api('IPlayerService', 'GetBadges', 1, { steamid }).catch(() => null),
    api('IPlayerService', 'GetOwnedGames', 1, {
      steamid,
      include_appinfo: 1,
      include_played_free_games: 1,
      skip_unvetted_apps: 0,
    }),
    api('IWishlistService', 'GetWishlist', 1, { steamid }).catch(() => null),
  ]);
  const player = summary.response.players[0];
  if (!player) throw new Error('Profile not found.');
  const games = owned.response.games;
  if (!games) throw new Error('No games returned. Set Steam Privacy → "Game details" to Public and try again.');

  // Achievements for every game with playtime. Games without stats return 400; that's fine.
  console.log('Fetching achievements…');
  const played = games.filter((g) => g.playtime_forever > 0);
  const achievements = new Map();
  let done = 0;
  let forbidden = 0;
  await Promise.all(
    played.map(async (g) => {
      try {
        const { playerstats } = await api('ISteamUserStats', 'GetPlayerAchievements', 1, {
          steamid,
          appid: g.appid,
          l: 'english',
        });
        if (playerstats?.achievements?.length) achievements.set(g.appid, playerstats.achievements);
      } catch (err) {
        // 400 = the game has no stats (normal). 403 = Steam is hiding achievements.
        if (err.status === 403) forbidden++;
      }
      if (++done % 50 === 0) console.log(`  achievements: ${done}/${played.length}`);
    }),
  );
  if (forbidden && !achievements.size)
    console.warn('  ⚠ Steam hid every achievement ("Profile is not public"). Set Steam → Edit Profile → Privacy Settings → "Game details" to Public, then re-run.');

  return {
    profile: {
      steamid,
      name: player.personaname,
      avatar: player.avatarfull,
      profileUrl: player.profileurl,
      createdAt: player.timecreated ?? null,
      level: badges?.response?.player_level ?? null,
      xp: badges?.response?.player_xp ?? null,
      badges: badges?.response?.badges?.length ?? null,
    },
    games: games.map((g) => ({
      appid: g.appid,
      name: g.name,
      icon: g.img_icon_url,
      minutes: g.playtime_forever,
      minutes2w: g.playtime_2weeks ?? 0,
      lastPlayed: g.rtime_last_played || null,
      platforms: {
        windows: g.playtime_windows_forever ?? 0,
        mac: g.playtime_mac_forever ?? 0,
        // Steam Deck runs SteamOS, so Deck time is also counted as Linux time. Split it out.
        linux: Math.max(0, (g.playtime_linux_forever ?? 0) - (g.playtime_deck_forever ?? 0)),
        deck: g.playtime_deck_forever ?? 0,
      },
    })),
    achievements,
    wishlist: (wishlist?.response?.items ?? []).map((w) => ({ appid: w.appid, addedAt: w.date_added, priority: w.priority })),
  };
}

// Demo account ----------------------------------------------------------------

// A deterministic, made-up library assembled from real popular games, so the pages
// can be built and reviewed without anyone's API key.
function seeded(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

async function fetchDemoAccount() {
  console.log('Building demo library…');
  const rand = seeded(42);
  const pool = [...(await spyList('top100forever')), ...(await spyList('top100in2weeks'))];
  const unique = [...new Map(pool.map((g) => [g.appid, g])).values()].sort((a, b) => a.appid - b.appid);
  // Shuffle, then keep ~60% of the popular pool as "owned".
  for (let i = unique.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [unique[i], unique[j]] = [unique[j], unique[i]];
  }
  const owned = unique.slice(0, 95);
  const now = Math.floor(Date.now() / 1000);
  const year = 365 * 24 * 3600;

  const games = owned.map((g, i) => {
    // Heavy-tailed playtime: a few obsessions, a long middle, and a backlog.
    const unplayed = rand() < 0.22;
    const minutes = unplayed ? 0 : Math.round(60 * (0.3 + 900 * Math.pow(rand(), 4.2)));
    const lastPlayed = unplayed ? null : now - Math.floor(Math.pow(rand(), 1.6) * 7 * year);
    const recent = !unplayed && i % 11 === 0 ? Math.round(60 + rand() * 900) : 0;
    const deck = rand() < 0.3 ? Math.round(minutes * rand() * 0.5) : 0;
    const mac = rand() < 0.15 ? Math.round((minutes - deck) * rand() * 0.6) : 0;
    return {
      appid: g.appid,
      name: g.name,
      icon: null,
      minutes,
      minutes2w: recent,
      lastPlayed: recent ? now - Math.floor(rand() * 13 * 86400) : lastPlayed,
      platforms: { windows: minutes - deck - mac, mac, linux: 0, deck },
    };
  });

  // Simulated unlocks for the most-played games, drawn from real global unlock rates.
  const achievements = new Map();
  const top = [...games].sort((a, b) => b.minutes - a.minutes).slice(0, 25);
  for (const g of top) {
    try {
      const data = await api('ISteamUserStats', 'GetGlobalAchievementPercentagesForApp', 2, { gameid: g.appid });
      const list = data?.achievementpercentages?.achievements ?? [];
      if (!list.length) continue;
      const skill = Math.min(1, 0.35 + g.minutes / 30000);
      const start = (g.lastPlayed ?? now) - Math.floor(rand() * 4 * year);
      achievements.set(
        g.appid,
        list.map((a) => {
          const achieved = rand() < Math.min(0.98, (Number(a.percent) / 100) * 1.4 * skill + 0.05);
          return {
            apiname: a.name,
            achieved: achieved ? 1 : 0,
            unlocktime: achieved ? start + Math.floor(rand() * Math.max(1, (g.lastPlayed ?? now) - start)) : 0,
            name: a.name.replace(/^(ACH|ACHIEVEMENT|Ach)_?/i, '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim(),
            description: '',
          };
        }),
      );
    } catch {}
  }

  const wishlist = unique.slice(95, 103).map((g, i) => ({ appid: g.appid, addedAt: now - i * 40 * 86400, priority: i }));
  return {
    profile: {
      steamid: '76561190000000000',
      name: 'Demo Player',
      avatar: null,
      profileUrl: 'https://steamcommunity.com/',
      createdAt: now - 16 * year,
      level: 37,
      xp: 9840,
      badges: 64,
    },
    games,
    achievements,
    wishlist,
  };
}

// Achievements ----------------------------------------------------------------

async function summarizeAchievements(appid, list) {
  const unlocked = list.filter((a) => a.achieved);
  let rarity = new Map();
  try {
    const data = await api('ISteamUserStats', 'GetGlobalAchievementPercentagesForApp', 2, { gameid: appid });
    rarity = new Map((data?.achievementpercentages?.achievements ?? []).map((a) => [a.name, Number(a.percent)]));
  } catch {}
  const rarest = unlocked
    .map((a) => ({ name: a.name || a.apiname, description: a.description || '', percent: rarity.get(a.apiname) ?? null, unlockedAt: a.unlocktime || null }))
    .filter((a) => a.percent != null)
    .sort((a, b) => a.percent - b.percent)
    .slice(0, 3);
  return {
    total: list.length,
    unlocked: unlocked.length,
    rarest,
    unlockTimes: unlocked.map((a) => a.unlocktime).filter(Boolean).sort((a, b) => a - b),
  };
}

// Recommendations -------------------------------------------------------------

// Store genres that mark an app as software (streaming tools, editors), not a game.
const NON_GAME_GENRES = new Set(tagLists.softwareGenres);

// Tags that describe format or vibe rather than what kind of game it is. They still
// count toward matching (discounted by how common they are), but never headline the
// taste profile. Broad genres can headline it, but are too wide to seed the search.
const META_TAGS = new Set(tagLists.meta);
const BROAD_TAGS = new Set(tagLists.broad);

const baseName = (name = '') =>
  name
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/\b(legacy|enhanced|remastered|special|definitive|anniversary|complete|goty|game of the year|deluxe|ultimate|director'?s cut|edition)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// "Counter-Strike: Condition Zero" and "Counter-Strike 2" → "counter strike".
const franchise = (name = '') =>
  baseName(name.split(/[:\-–—]\s/)[0])
    .replace(/\s+(\d+|[ivx]+)$/, '')
    .trim();

const tagVector = (tags = []) => {
  const max = tags[0]?.votes || 1;
  return new Map(tags.map((t) => [t.name, t.votes / max]));
};

function cosine(a, b, idf) {
  let dot = 0, na = 0, nb = 0;
  for (const [t, v] of a) {
    const w = v * (idf.get(t) ?? 1);
    na += w * w;
    if (b.has(t)) dot += w * b.get(t) * (idf.get(t) ?? 1);
  }
  for (const [t, v] of b) nb += (v * (idf.get(t) ?? 1)) ** 2;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// Lower bound of the 95% confidence interval on the positive-review share, so a
// 100% game with 12 reviews doesn't outrank a 96% game with 200,000.
function wilson(pos, neg) {
  const n = pos + neg;
  if (!n) return 0;
  const z = 1.96, p = pos / n;
  return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / (1 + (z * z) / n);
}

async function buildPicks(games, meta, wishlist) {
  const owned = new Set(games.map((g) => g.appid));
  // "Skyrim" and "Skyrim Special Edition", or GTA V "Legacy" and "Enhanced", are one game for our purposes.
  const ownedNames = new Set(games.map((g) => baseName(g.name)));
  const isSoftware = (appid) => (meta.get(appid)?.store?.genres ?? []).some((g) => NON_GAME_GENRES.has(g));
  const played = games.filter((g) => g.minutes >= 60 && meta.get(g.appid)?.spy?.tags?.length && !isSoftware(g.appid));

  // Candidate sources, each remembered so groups can be drawn from them.
  console.log('Gathering popular games…');
  const [charts, trending, allTime, featured] = await Promise.all([
    api('ISteamChartsService', 'GetMostPlayedGames', 1, {}).then((d) => d.response.ranks.map((r) => r.appid)).catch(() => []),
    spyList('top100in2weeks').then((l) => l.map((g) => g.appid)),
    spyList('top100forever').then((l) => l.map((g) => g.appid)),
    cached('store-featured', 24 * 60 * 60 * 1000, () => getJson('https://store.steampowered.com/api/featuredcategories?cc=us&l=english')).catch(() => ({})),
  ]);
  const featuredIds = (k) => (featured?.[k]?.items ?? []).map((i) => i.id);
  const sources = {
    charts: new Set(charts),
    trending: new Set([...trending, ...featuredIds('top_sellers')]),
    allTime: new Set(allTime),
    sale: new Set(featuredIds('specials')),
    fresh: new Set(featuredIds('new_releases')),
    wishlist: new Set(wishlist.map((w) => w.appid)),
    taste: new Set(),
  };

  // Taste profile: each played game's tags weighted by sqrt(hours), so a 2,000-hour
  // game counts heavily but doesn't drown out everything else.
  const df = new Map();
  const countTags = (tags) => tags.forEach((t) => df.set(t.name, (df.get(t.name) ?? 0) + 1));
  for (const g of games) countTags(meta.get(g.appid)?.spy?.tags ?? []);
  let docs = games.length;
  const idfOf = () => new Map([...df].map(([t, n]) => [t, Math.log((docs + 1) / (n + 1)) + 1]));
  let idf = idfOf();

  const profile = new Map();
  for (const g of played) {
    const w = Math.sqrt(g.minutes / 60);
    for (const [t, v] of tagVector(meta.get(g.appid).spy.tags)) profile.set(t, (profile.get(t) ?? 0) + w * v);
  }
  const profileRanked = [...profile].map(([t, v]) => [t, v * idf.get(t)]).sort((a, b) => b[1] - a[1]);

  // Pull in well-reviewed games from your strongest distinctive tags too, so picks
  // aren't limited to the charts.
  const distinctive = profileRanked.filter(([t]) => !META_TAGS.has(t));
  const tasteTags = distinctive.filter(([t]) => !BROAD_TAGS.has(t)).slice(0, 4).map(([t]) => t);
  for (const tag of tasteTags) {
    const list = await spyList('tag', `&tag=${encodeURIComponent(tag)}`).catch(() => []);
    list
      .filter((g) => g.positive + g.negative >= 3000 && g.positive / (g.positive + g.negative) >= 0.85)
      .sort((a, b) => b.positive + b.negative - (a.positive + a.negative))
      .slice(0, 30)
      .forEach((g) => sources.taste.add(g.appid));
  }

  const candidateIds = [...new Set(Object.values(sources).flatMap((s) => [...s]))].filter((id) => !owned.has(id));
  console.log(`Scoring ${candidateIds.length} games you don't own…`);
  const candMeta = await enrich(candidateIds, 'candidates');
  for (const id of candidateIds) countTags(candMeta.get(id)?.spy?.tags ?? []);
  docs += candidateIds.length;
  idf = idfOf();

  const playedVecs = played.map((g) => ({ g, vec: tagVector(meta.get(g.appid).spy.tags), w: Math.sqrt(g.minutes / 60) }));
  const scored = [];
  // Wishlisted games too new for SteamSpy to have tags can't be matched, but still belong on the wishlist.
  const unmatchedWishlist = [];
  for (const appid of candidateIds) {
    const { store, spy } = candMeta.get(appid) ?? {};
    if (store?.type === 'game' && !store.adult && !spy?.tags?.length && sources.wishlist.has(appid)) {
      const reviews = spy ? spy.positive + spy.negative : 0;
      unmatchedWishlist.push({
        appid,
        name: store.name,
        header: store.header,
        short: store.short,
        developer: store.developers[0] ?? null,
        release: store.release,
        isFree: store.isFree,
        priceCents: store.price?.final ?? 0,
        fullPriceCents: store.price?.initial ?? 0,
        discount: store.price?.discount ?? 0,
        reviewPct: reviews ? Math.round((100 * spy.positive) / reviews) : null,
        comingSoon: store.comingSoon,
        reviews,
        ccu: spy?.ccu ?? 0,
        owners: spy?.owners ?? '',
        tags: store.genres.slice(0, 4),
        sharedTags: [],
        because: [],
        wishlisted: true,
        match: null,
        score: 0,
        addedAt: wishlist.find((w) => w.appid === appid)?.addedAt ?? 0,
      });
    }
    if (!store || !spy?.tags?.length) continue;
    // Wishlisted games skip the release and review gates: you've already picked them out.
    const wishlisted = sources.wishlist.has(appid);
    if (store.type !== 'game' || store.adult) continue;
    if (store.genres.some((g) => NON_GAME_GENRES.has(g))) continue;
    const reviews = spy.positive + spy.negative;
    if (!wishlisted && (store.comingSoon || reviews < 300 || spy.positive / reviews < 0.7)) continue;
    if (ownedNames.has(baseName(store.name))) continue;

    const vec = tagVector(spy.tags);
    const affinity = cosine(profile, vec, idf);
    const because = playedVecs
      .map(({ g, vec: v, w }) => ({ name: g.name, appid: g.appid, s: cosine(v, vec, idf) * Math.log1p(w) }))
      .filter((x) => x.s > 0.3)
      .sort((a, b) => b.s - a.s)
      .slice(0, 2)
      .map(({ name, appid: id }) => ({ name, appid: id }));
    const sharedTags = [...vec]
      .filter(([t]) => profile.has(t) && !META_TAGS.has(t))
      .map(([t, v]) => [t, v * profile.get(t) * idf.get(t) ** 2])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([t]) => t);

    scored.push({
      appid,
      name: store.name,
      header: store.header,
      short: store.short,
      developer: store.developers[0] ?? null,
      release: store.release,
      isFree: store.isFree,
      priceCents: store.price?.final ?? spy.priceCents,
      fullPriceCents: store.price?.initial ?? spy.priceCents,
      discount: store.price?.discount ?? 0,
      reviewPct: reviews ? Math.round((100 * spy.positive) / reviews) : null,
      comingSoon: store.comingSoon,
      reviews,
      ccu: spy.ccu,
      owners: spy.owners,
      tags: spy.tags.slice(0, 5).map((t) => t.name),
      sharedTags,
      because,
      wishlisted,
      affinity,
      quality: wilson(spy.positive, spy.negative),
      popularity: Math.log10(reviews + 1),
    });
  }

  // Blend: mostly taste, then quality, then popularity. Each normalized to 0–1 first.
  const norm = (k) => {
    const vals = scored.map((s) => s[k]);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    return (v) => (hi > lo ? (v - lo) / (hi - lo) : 0);
  };
  const nA = norm('affinity'), nQ = norm('quality'), nP = norm('popularity');
  for (const s of scored) {
    s.match = Math.round(100 * nA(s.affinity));
    s.score = 0.6 * nA(s.affinity) + 0.25 * nQ(s.quality) + 0.15 * nP(s.popularity) + (s.wishlisted ? 0.05 : 0);
  }
  scored.sort((a, b) => b.score - a.score);

  // Each game appears in one group at most, and only one game per series.
  const used = new Set();
  const take = (filter, n) => {
    const out = [];
    for (const s of scored) {
      if (out.length === n) break;
      const name = franchise(s.name);
      if (!filter(s) || used.has(name)) continue;
      out.push(s);
      used.add(name);
    }
    return out;
  };
  const clean = ({ affinity, quality, popularity, ...rest }) => ({ ...rest, score: Math.round(rest.score * 1000) / 1000 });

  const groups = [
    { id: 'best', title: 'Best matches', blurb: 'The strongest overlap with what you actually spend time on, weighted toward well-reviewed games.', items: take((s) => !s.comingSoon && s.reviews >= 300, 12) },
    { id: 'now', title: 'Popular right now', blurb: 'Most-played and top-selling on Steam this week, ranked by fit.', items: take((s) => s.match >= 30 && (sources.charts.has(s.appid) || sources.trending.has(s.appid)), 8) },
    { id: 'greats', title: 'All-time greats you skipped', blurb: 'Steam’s most-owned, best-reviewed games that aren’t in your library.', items: take((s) => s.match >= 30 && sources.allTime.has(s.appid) && s.reviewPct >= 85, 8) },
    { id: 'sale', title: 'On sale now', blurb: 'Currently discounted, ranked by fit.', items: take((s) => s.match >= 30 && s.discount > 0, 8) },
    { id: 'wishlist', title: 'Your wishlist, ranked', blurb: 'What you’ve already flagged, ordered by how well it fits your play history.', items: [
      ...scored.filter((s) => s.wishlisted),
      ...unmatchedWishlist.sort((a, b) => b.addedAt - a.addedAt).map(({ addedAt, ...rest }) => rest),
    ] },
  ]
    .map((g) => ({ ...g, items: g.items.map(clean) }))
    .filter((g) => g.items.length);

  return {
    profileTags: distinctive.slice(0, 14).map(([tag, w]) => ({ tag, weight: Math.round(w * 10) / 10 })),
    tasteTags,
    candidates: scored.length,
    groups,
  };
}

// Main ------------------------------------------------------------------------

await mkdir(CACHE_DIR, { recursive: true });
await mkdir(path.dirname(OUT), { recursive: true });

const account = opts.demo ? await fetchDemoAccount() : await fetchAccount(await resolveSteamId(idInput));
console.log(`${account.games.length} games. Fetching store + SteamSpy details…`);
const meta = await enrich(account.games.map((g) => g.appid), 'library');

console.log('Summarizing achievements…');
const achievementSummaries = new Map();
for (const [appid, list] of account.achievements) achievementSummaries.set(appid, await summarizeAchievements(appid, list));

const games = account.games.map((g) => {
  const { store, spy } = meta.get(g.appid) ?? {};
  return {
    ...g,
    name: g.name || store?.name || `App ${g.appid}`,
    header: store?.header ?? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${g.appid}/header.jpg`,
    release: store?.release ?? null,
    genres: store?.genres ?? [],
    developer: store?.developers?.[0] ?? null,
    metacritic: store?.metacritic ?? null,
    isFree: store?.isFree ?? false,
    priceCents: store?.price?.initial ?? spy?.priceCents ?? 0,
    tags: spy?.tags ?? [],
    reviews: spy ? { positive: spy.positive, negative: spy.negative } : null,
    medianMinutes: spy?.medianMinutes || null,
    achievements: achievementSummaries.get(g.appid) ?? null,
  };
});

const picks = await buildPicks(account.games, meta, account.wishlist);

const snapshot = {
  generatedAt: new Date().toISOString(),
  demo: opts.demo,
  currency: 'USD',
  profile: account.profile,
  games: games.sort((a, b) => b.minutes - a.minutes),
  wishlist: account.wishlist,
  picks,
};
await writeFile(OUT, JSON.stringify(snapshot, null, 1) + '\n');
console.log(`Wrote ${path.relative(ROOT, OUT)} (${games.length} games, ${picks.groups.reduce((n, g) => n + g.items.length, 0)} picks).`);
