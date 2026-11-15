#!/usr/bin/env node
// Pulls your PlayStation Network library (play time, play count, first/last played,
// plus everything you own but haven't launched), trophy progress and your trophy
// summary into src/data/psn/snapshot.json. Then it reads the public PlayStation Store
// catalog to build genre-matched recommendations in src/data/psn/store.json.
//
//   npm run psn:sync                  # library + store
//   npm run psn:sync -- --no-store    # library only (fast)
//   npm run psn:sync -- --refresh     # ignore the store cache
//
// The store has no review scores, so picks are matched on genre and ranked by how well
// they sell. Store responses are cached in .cache/psn for a day.
//
// There is no official PSN API. This uses the unofficial `psn-api` package, which
// signs in with an NPSSO cookie from your own browser session:
//   1. Sign in at https://www.playstation.com
//   2. Visit https://ca.account.sony.com/api/v1/ssocookie
//   3. Copy the 64-character "npsso" value into PSN_NPSSO in .env
// The cookie expires after ~2 months; re-copy it when the sync starts failing with 401s.
// Only your own account's play time is available this way. NEVER commit the token.
import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  exchangeNpssoForAccessCode,
  exchangeAccessCodeForAuthTokens,
  getPurchasedGames,
  getUserPlayedGames,
  getUserTitles,
  getUserTrophyProfileSummary,
  getProfileFromAccountId,
} from 'psn-api';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'src/data/psn/snapshot.json');
const STORE_OUT = path.join(ROOT, 'src/data/psn/store.json');
const CACHE_DIR = path.join(ROOT, '.cache/psn');
const PAGE = 200;

const { values: opts } = parseArgs({
  options: {
    'no-store': { type: 'boolean', default: false },
    refresh: { type: 'boolean', default: false },
  },
});

const npsso = process.env.PSN_NPSSO?.trim();
if (!npsso) {
  console.error('Set PSN_NPSSO in .env. See the header of scripts/sync-psn.mjs for how to get it.');
  process.exit(1);
}

// "PT228H56M33S" -> minutes. Seconds are rounded; the API is accurate to 1s.
function durationToMinutes(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso ?? '');
  if (!m) return 0;
  return Math.round((Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) / 60);
}

async function pageAll(fetchPage, key) {
  const items = [];
  for (let offset = 0; ; offset += PAGE) {
    const res = await fetchPage({ limit: PAGE, offset });
    items.push(...(res[key] ?? []));
    if (res.nextOffset == null || res.nextOffset <= offset || items.length >= res.totalItemCount) break;
  }
  return items;
}

console.log('Signing in…');
let auth;
try {
  const code = await exchangeNpssoForAccessCode(npsso);
  auth = await exchangeAccessCodeForAuthTokens(code);
} catch (err) {
  console.error(`PSN sign-in failed: ${err.message}\nThe NPSSO token is probably expired or mistyped.`);
  process.exit(1);
}

console.log('Fetching played games…');
const played = await pageAll((o) => getUserPlayedGames(auth, 'me', o), 'titles');

console.log('Fetching trophy titles…');
const trophyTitles = await pageAll((o) => getUserTitles(auth, 'me', o), 'trophyTitles');

console.log('Fetching purchased library…');
const purchased = [];
for (let start = 0; ; start += PAGE) {
  const res = await getPurchasedGames(auth, { platform: ['ps4', 'ps5'], size: PAGE, start, sortBy: 'ACTIVE_DATE', sortDirection: 'desc' });
  const page = res.data.purchasedTitlesRetrieve.games;
  purchased.push(...page);
  if (page.length < PAGE) break;
}

console.log('Fetching trophy summary + profile…');
const summary = await getUserTrophyProfileSummary(auth, 'me');
let profile = null;
try {
  profile = await getProfileFromAccountId(auth, summary.accountId);
} catch (err) {
  console.warn(`  profile lookup failed: ${err.message}`);
}

const imageFor = (g) =>
  g.concept?.media?.images?.find((i) => i.type === 'FOUR_BY_THREE_BANNER' || i.type === 'GAMEHUB_COVER_ART')?.url ??
  g.imageUrl ??
  null;

const games = played
  .map((g) => ({
    titleId: g.titleId,
    conceptId: g.concept?.id ?? null,
    name: g.name,
    image: imageFor(g),
    icon: g.imageUrl ?? null,
    platform: g.category,
    service: g.service,
    minutes: durationToMinutes(g.playDuration),
    playCount: g.playCount,
    firstPlayed: g.firstPlayedDateTime ?? null,
    lastPlayed: g.lastPlayedDateTime ?? null,
  }))
  .sort((a, b) => b.minutes - a.minutes);

const trophies = trophyTitles.map((t) => ({
  npCommunicationId: t.npCommunicationId,
  name: t.trophyTitleName,
  icon: t.trophyTitleIconUrl,
  platform: t.trophyTitlePlatform,
  progress: t.progress,
  defined: t.definedTrophies,
  earned: t.earnedTrophies,
  lastEarned: t.lastUpdatedDateTime,
}));

// Everything you own, played or not. `membership` tells PS Plus claims apart from purchases.
const library = purchased.map((g) => ({
  titleId: g.titleId,
  productId: g.productId,
  name: g.name,
  image: g.image?.url ?? null,
  platform: g.platform,
  membership: g.membership,
}));

const snapshot = {
  generatedAt: new Date().toISOString(),
  profile: {
    accountId: summary.accountId,
    onlineId: profile?.onlineId ?? null,
    avatar: profile?.avatars?.at(-1)?.url ?? null,
    isPlus: profile?.isPlus ?? null,
    trophyLevel: Number(summary.trophyLevel),
    trophyProgress: summary.progress,
    trophyTier: summary.tier,
    earnedTrophies: summary.earnedTrophies,
  },
  games,
  purchased: library,
  trophies,
};

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(snapshot, null, 1) + '\n');

const hours = Math.round(games.reduce((n, g) => n + g.minutes, 0) / 60);
console.log(`\nWrote ${path.relative(process.cwd(), OUT)}`);
console.log(`  ${games.length} played games, ${hours}h total play time`);
console.log(`  ${library.length} owned titles (${library.filter((g) => g.membership === 'PS_PLUS').length} via PS Plus)`);
console.log(`  ${trophies.length} trophy titles, level ${snapshot.profile.trophyLevel}`);
console.log('  top by play time:');
for (const g of games.slice(0, 5)) console.log(`    ${(g.minutes / 60).toFixed(1).padStart(7)}h  ${g.name}`);

// Store recommendations ------------------------------------------------------------

if (opts['no-store']) {
  console.log('\nSkipping the store (--no-store).');
  process.exit(0);
}

try {
  await buildStore();
} catch (err) {
  // The store endpoint is unofficial; if it changes, keep the library data and the last good picks.
  console.warn(`\nStore step failed: ${err.message}\nThe library snapshot was written; store.json was left as it was.`);
}

async function buildStore() {
  console.log('\nReading the PlayStation Store…');
  await mkdir(CACHE_DIR, { recursive: true });

  // Persisted GraphQL query the store website itself uses for its category grids.
  const HASH = '9845afc0dbaab4965f6563fffc703f588c8e76792000e8610843b8d3ee9c4c09';
  const CATEGORY = { PS5: 'd71e8e6d-0940-4e03-bd02-404fc7d31a31', PS4: '44d8bb20-653e-431e-8ad0-c0a365f68d2f' };
  const GENRES = {
    ACTION: 'Action', ADVENTURE: 'Adventure', ROLE_PLAYING_GAMES: 'RPG', SHOOTER: 'Shooter', FIRST_PERSON_SHOOTER: 'First-person shooter',
    THIRD_PERSON_SHOOTER: 'Third-person shooter', STRATEGY: 'Strategy', SIMULATION: 'Simulation', SIMULATOR: 'Simulator', PLATFORMER: 'Platformer',
    PUZZLE: 'Puzzle', HORROR: 'Horror', RACING: 'Racing', SPORTS: 'Sports', FIGHTING: 'Fighting', STEALTH: 'Stealth', ARCADE: 'Arcade',
    FANTASY: 'Fantasy', COMBAT: 'Combat', UNIQUE: 'Unique',
  };
  const PAGES_PER_GENRE = 2; // 200 per page, best sellers first
  const TTL = 24 * 60 * 60 * 1000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cents = (t) => (t ? Math.round(parseFloat(t.replace(/[^0-9.]/g, '')) * 100) || 0 : 0);

  const imageOf = (media = []) => {
    for (const role of ['BACKGROUND', 'FOUR_BY_THREE_BANNER', 'MASTER', 'EDITION_KEY_ART'])
      for (const m of media) if (m.type === 'IMAGE' && m.role === role) return m.url;
    return null;
  };
  const slim = (p) => ({
    id: p.id,
    titleId: p.npTitleId,
    name: p.name,
    platforms: p.platforms ?? [],
    image: imageOf(p.media),
    priceCents: cents(p.price?.discountedPrice),
    fullPriceCents: cents(p.price?.basePrice),
    discount: Math.abs(parseInt(p.price?.discountText ?? '0', 10)) || 0,
    isFree: !!p.price?.isFree,
    plusOnly: !!p.price?.isTiedToSubscription,
  });

  async function page(category, filterBy, offset) {
    const key = `${category.slice(0, 8)}-${filterBy.join('+')}-${offset}`.replace(/[^a-zA-Z0-9_+.-]/g, '_');
    const file = path.join(CACHE_DIR, `${key}.json`);
    if (!opts.refresh) {
      try {
        const { at, data } = JSON.parse(await readFile(file, 'utf8'));
        if (Date.now() - at < TTL) return data;
      } catch {}
    }
    const variables = { id: category, pageArgs: { size: PAGE, offset }, sortBy: { name: 'sales30', isAscending: false }, filterBy, facetOptions: [] };
    const extensions = { persistedQuery: { version: 1, sha256Hash: HASH } };
    const url = `https://web.np.playstation.com/api/graphql/v1/op?operationName=categoryGridRetrieve&variables=${encodeURIComponent(JSON.stringify(variables))}&extensions=${encodeURIComponent(JSON.stringify(extensions))}`;
    let json;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        headers: {
          'x-psn-store-locale-override': 'en-US',
          'content-type': 'application/json',
          origin: 'https://store.playstation.com',
          referer: 'https://store.playstation.com/',
          'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130 Safari/537.36',
        },
      });
      if (res.ok) { json = await res.json(); break; }
      if (attempt < 3) { await sleep(2000 * (attempt + 1)); continue; }
      throw new Error(`store returned ${res.status}`);
    }
    if (json.errors?.length) throw new Error(`store: ${json.errors[0].message} (the persisted query may have been retired)`);
    const grid = json.data.categoryGridRetrieve;
    const data = { products: grid.products.map(slim), total: grid.pageInfo.totalCount };
    await writeFile(file, JSON.stringify({ at: Date.now(), data }));
    await sleep(150);
    return data;
  }

  // titleId -> product; each product collects the genres it was listed under.
  const catalog = new Map();
  const bestSellers = new Map(); // titleId -> rank within its platform's overall chart
  const add = (p, genre) => {
    const e = catalog.get(p.titleId) ?? { ...p, genres: new Set() };
    if (genre) e.genres.add(genre);
    catalog.set(p.titleId, e);
  };

  let requests = 0;
  for (const platform of ['PS5', 'PS4']) {
    // Overall chart: the popularity signal.
    for (let n = 0; n < 3; n++) {
      const { products } = await page(CATEGORY[platform], ['storeDisplayClassification:FULL_GAME'], n * PAGE);
      products.forEach((p, i) => { add(p); bestSellers.set(p.titleId, n * PAGE + i); });
      requests++;
    }
    for (const genre of Object.keys(GENRES)) {
      for (let n = 0; n < PAGES_PER_GENRE; n++) {
        const { products, total } = await page(CATEGORY[platform], [`productGenres:${genre}`, 'storeDisplayClassification:FULL_GAME'], n * PAGE);
        products.forEach((p) => add(p, genre));
        requests++;
        if ((n + 1) * PAGE >= total) break;
      }
    }
    console.log(`  ${platform}: ${catalog.size} products so far`);
  }
  console.log(`  catalog: ${catalog.size} full games from ${requests} requests`);

  // Name keys ---------------------------------------------------------------
  const baseName = (name = '') =>
    name
      .toLowerCase()
      .replace(/[™®©]/g, '')
      .replace(/\(.*?\)/g, '')
      .replace(/\b(legacy|enhanced|remastered|remake|special|definitive|anniversary|complete|goty|game of the year|deluxe|ultimate|premium|digital|standard|gold|collectors?|director'?s cut|edition|bundle|ps4|ps5|the)\b/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  // "Call of Duty: Black Ops 6" and "Call of Duty: Modern Warfare 4" are one series for picking purposes.
  const franchise = (name = '') => baseName(name.split(/[:\-–—]\s/)[0]).replace(/\s+(\d+|[ivx]+)$/, '').trim();

  const byName = new Map();
  for (const p of catalog.values()) {
    const k = baseName(p.name);
    const prev = byName.get(k);
    byName.set(k, prev ? { ...prev, genres: new Set([...prev.genres, ...p.genres]) } : p);
  }
  const genresOf = (titleIds, names) => {
    const out = new Set();
    for (const id of titleIds) catalog.get(id)?.genres.forEach((g) => out.add(g));
    if (!out.size) for (const n of names) byName.get(baseName(n))?.genres.forEach((g) => out.add(g));
    return out;
  };

  // Taste profile ---------------------------------------------------------------
  const df = new Map();
  for (const p of catalog.values()) p.genres.forEach((g) => df.set(g, (df.get(g) ?? 0) + 1));
  const idf = new Map([...df].map(([g, n]) => [g, Math.log((catalog.size + 1) / (n + 1)) + 1]));
  const vec = (genres) => new Map([...genres].map((g) => [g, 1]));
  const cosine = (a, b) => {
    let dot = 0, na = 0, nb = 0;
    for (const [t] of a) { const w = (idf.get(t) ?? 1) * a.get(t); na += w * w; if (b.has(t)) dot += w * (idf.get(t) ?? 1) * b.get(t); }
    for (const [t] of b) nb += ((idf.get(t) ?? 1) * b.get(t)) ** 2;
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
  };

  // One entry per game: PS4 and PS5 versions share a concept.
  const groups = new Map();
  for (const g of played) {
    const k = g.concept?.id != null ? `c${g.concept.id}` : `n${baseName(g.name)}`;
    const e = groups.get(k) ?? { names: [], titleIds: [], minutes: 0 };
    e.names.push(g.name);
    e.titleIds.push(g.titleId);
    e.minutes += durationToMinutes(g.playDuration);
    groups.set(k, e);
  }
  const profile = new Map();
  const playedVecs = [];
  let matchedPlayed = 0;
  for (const e of groups.values()) {
    if (e.minutes < 60) continue;
    const genres = genresOf(e.titleIds, e.names);
    if (!genres.size) continue;
    matchedPlayed++;
    const w = Math.sqrt(e.minutes / 60);
    for (const g of genres) profile.set(g, (profile.get(g) ?? 0) + w);
    playedVecs.push({ name: e.names[0].replace(/[™®©]/g, '').trim(), vec: vec(genres), w });
  }
  const playedCount = [...groups.values()].filter((e) => e.minutes >= 60).length;
  console.log(`  taste profile built from ${matchedPlayed} of ${playedCount} games you've played (the rest aren't in the store catalog)`);
  const profileRanked = [...profile].map(([g, w]) => [g, w * (idf.get(g) ?? 1)]).sort((a, b) => b[1] - a[1]);

  // Ownership ---------------------------------------------------------------
  const ownedTitleIds = new Set([...played.map((g) => g.titleId), ...purchased.map((g) => g.titleId)]);
  const ownedNames = new Set([...played.map((g) => baseName(g.name)), ...purchased.map((g) => baseName(g.name))]);

  // Candidates: one per game, PS5 version preferred ----------------------------------
  const scoredMap = new Map();
  for (const p of catalog.values()) {
    if (!p.genres.size) continue;
    if (ownedTitleIds.has(p.titleId) || ownedNames.has(baseName(p.name))) continue;
    const key = baseName(p.name);
    const prev = scoredMap.get(key);
    const better = !prev || (p.platforms.includes('PS5') && !prev.platforms.includes('PS5'));
    const merged = { ...(better ? p : prev), genres: new Set([...(prev?.genres ?? []), ...p.genres]), platforms: [...new Set([...(prev?.platforms ?? []), ...p.platforms])].sort().reverse() };
    const ranks = [bestSellers.get(p.titleId), prev && bestSellers.get(prev.titleId)].filter((x) => x != null);
    merged.rank = ranks.length ? Math.min(...ranks) : null;
    scoredMap.set(key, merged);
  }
  const candidates = [...scoredMap.values()].map((p) => {
    const v = vec(p.genres);
    const affinity = cosine(profile, v);
    const because = playedVecs
      .map((pv) => ({ name: pv.name, s: cosine(pv.vec, v) * Math.log1p(pv.w) }))
      .filter((x) => x.s > 0.35)
      .sort((a, b) => b.s - a.s)
      .slice(0, 2)
      .map((x) => x.name);
    const sharedGenres = [...p.genres].filter((g) => profile.has(g)).sort((a, b) => (profile.get(b) * (idf.get(b) ?? 1)) - (profile.get(a) * (idf.get(a) ?? 1))).slice(0, 3);
    return { ...p, affinity, because, sharedGenres, popularity: p.rank == null ? 0 : 1 - p.rank / 600 };
  });

  const lo = Math.min(...candidates.map((c) => c.affinity));
  const hi = Math.max(...candidates.map((c) => c.affinity));
  const nA = (v) => (hi > lo ? (v - lo) / (hi - lo) : 0);
  for (const c of candidates) {
    c.match = Math.round(100 * nA(c.affinity));
    c.score = 0.6 * nA(c.affinity) + 0.4 * c.popularity;
  }
  candidates.sort((a, b) => b.score - a.score);

  const used = new Set();
  const take = (filter, n) => {
    const out = [];
    for (const c of candidates) {
      if (out.length === n) break;
      const f = franchise(c.name);
      if (!filter(c) || used.has(f)) continue;
      out.push(c);
      used.add(f);
    }
    return out;
  };
  const clean = (c) => ({
    id: c.id,
    name: c.name.replace(/[™®©]/g, '').trim(),
    image: c.image,
    platforms: c.platforms,
    priceCents: c.priceCents,
    fullPriceCents: c.fullPriceCents,
    discount: c.discount,
    isFree: c.isFree,
    plusOnly: c.plusOnly,
    genres: [...c.genres].slice(0, 5).map((g) => GENRES[g]),
    sharedGenres: c.sharedGenres.map((g) => GENRES[g]),
    because: c.because,
    match: c.match,
    rank: c.rank,
  });
  const pickGroups = [
    { id: 'best', title: 'Best matches', blurb: 'The closest fit to the genres you actually spend time in, weighted toward what is selling well.', items: take((c) => c.match >= 40, 12) },
    { id: 'now', title: 'Best sellers right now', blurb: 'The PlayStation Store’s current top sellers, ranked by fit.', items: take((c) => c.match >= 40 && c.rank != null && c.rank < 150, 8) },
    { id: 'sale', title: 'On sale now', blurb: 'Currently discounted, ranked by fit.', items: take((c) => c.match >= 40 && c.discount >= 25, 8) },
  ]
    .map((g) => ({ ...g, items: g.items.map(clean) }))
    .filter((g) => g.items.length);

  // Fit and artwork for everything you own, so the backlog can be ranked alongside Steam's.
  // `match` is null when the store catalog has no genre data for the title.
  const owned = {};
  for (const g of purchased) {
    if (owned[g.titleId]) continue;
    const genres = genresOf([g.titleId], [g.name]);
    const image = catalog.get(g.titleId)?.image ?? byName.get(baseName(g.name))?.image ?? null;
    if (!genres.size && !image) continue;
    const match = genres.size ? Math.max(0, Math.min(100, Math.round((100 * (cosine(profile, vec(genres)) - lo)) / ((hi - lo) || 1)))) : null;
    owned[g.titleId] = { match, genres: [...genres].slice(0, 4).map((x) => GENRES[x]), image };
  }

  const store = {
    generatedAt: new Date().toISOString(),
    catalog: catalog.size,
    profile: profileRanked.slice(0, 10).map(([genre, w]) => ({ genre: GENRES[genre], weight: Math.round(w * 10) / 10 })),
    candidates: candidates.length,
    groups: pickGroups,
    owned,
  };
  await writeFile(STORE_OUT, JSON.stringify(store, null, 1) + '\n');
  console.log(`  wrote ${path.relative(process.cwd(), STORE_OUT)}: ${pickGroups.reduce((n, g) => n + g.items.length, 0)} picks, genres for ${Object.keys(owned).length} owned titles`);
}
