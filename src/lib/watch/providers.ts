// Turns TMDB's provider lists into what the Where to watch page shows: services you can pick,
// one tile per service, and a one-line answer to "where can I watch this?".
import type { Availability, MediaType, Provider } from './tmdb';

/**
 * TMDB lists tiers of one service as separate providers ("Netflix Standard with Ads",
 * "Paramount Plus Essential", "Peacock Premium Plus"). Someone who has Netflix has both,
 * so they count as one service.
 */
const aliases: Record<string, string> = {
  'paramount plus premium': 'Paramount Plus',
  'paramount plus essential': 'Paramount Plus',
  'peacock premium': 'Peacock',
  'peacock premium plus': 'Peacock',
  'sling tv orange': 'Sling TV',
  'sling tv orange and blue': 'Sling TV',
};
export const serviceName = (name: string) => {
  const base = name.trim().replace(/\s+(?:(?:standard|basic|free)\s+)?with ads$/i, '').trim();
  return aliases[base.toLowerCase()] ?? base;
};
export const serviceKey = (name: string) => serviceName(name).toLowerCase();

/** Add-ons bought through another service ("HBO Max Amazon Channel"). Listed after the service itself. */
export const isChannel = (name: string) => /\b(?:amazon|apple tv|roku premium)\s+channel$/i.test(name.trim());

/** A service picked as a filter, saved in the browser so its chip can show before any results load. */
export interface PickedService {
  key: string;
  name: string;
  logoPath: string | null;
}

export const toPicked = (p: Provider): PickedService => ({ key: serviceKey(p.provider_name), name: serviceName(p.provider_name), logoPath: p.logo_path });

/** One entry per service: a title on "Netflix" and "Netflix Standard with Ads" shows up once. */
export function uniqueServices(list: Provider[]): Provider[] {
  const seen = new Set<string>();
  return list.filter((p) => {
    const key = serviceKey(p.provider_name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type Tone = 'yours' | 'stream' | 'free' | 'paid' | 'none';

export interface Verdict {
  tone: Tone;
  /** For a chip: "On Netflix", "Rent or buy". */
  short: string;
  /** For a sentence: "Included with Netflix, which you have." */
  long: string;
}

const names = (list: Provider[]) => uniqueServices(list).map((p) => serviceName(p.provider_name));

/** "Netflix", "Netflix and Hulu", "Netflix, Hulu and 2 more". */
export function nameList(items: string[], max = 2) {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length <= max) return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

/** The single most useful thing to say about where a title is, given the services you have. */
export function verdict(a: Availability, mine: ReadonlySet<string>): Verdict {
  const included = [...a.stream, ...a.free];
  const yours = names(included.filter((p) => mine.has(serviceKey(p.provider_name))));
  if (yours.length) {
    return {
      tone: 'yours',
      short: yours.length > 1 ? `On ${yours[0]} +${yours.length - 1}` : `On ${yours[0]}`,
      long: `Included with ${nameList(yours, 3)}, which you have.`,
    };
  }
  const prefix = mine.size ? 'Not on your services. ' : '';
  const stream = names(a.stream);
  if (stream.length) {
    return {
      tone: 'stream',
      short: stream.length > 1 ? `${stream[0]} +${stream.length - 1}` : stream[0],
      long: `${prefix}Streaming on ${nameList(stream)}.`,
    };
  }
  const free = names(a.free);
  if (free.length) {
    return { tone: 'free', short: `Free on ${free[0]}`, long: `${prefix}Free with ads on ${nameList(free)}.` };
  }
  const paid = names([...a.rent, ...a.buy]);
  if (paid.length) {
    const how = a.rent.length && a.buy.length ? 'Rent or buy' : a.rent.length ? 'Rent' : 'Buy';
    return {
      tone: 'paid',
      short: how,
      long: `${mine.size ? 'Not on your services, and not' : 'Not'} streaming anywhere. ${how} it on ${nameList(paid)}.`,
    };
  }
  return { tone: 'none', short: 'Not available', long: 'Not available to stream, rent or buy in the US right now.' };
}

// A few services have a search page that takes the title in the URL, so their tiles can open
// straight onto it. Channels sold through Amazon or Apple are watched there, so they match first.
const searchPages: [RegExp, (q: string, type: MediaType) => string][] = [
  [/amazon/i, (q) => `https://www.amazon.com/s?k=${q}&i=instant-video`],
  [/apple tv/i, (q) => `https://tv.apple.com/search?term=${q}`],
  [/netflix/i, (q) => `https://www.netflix.com/search?q=${q}`],
  [/hulu/i, (q) => `https://www.hulu.com/search?q=${q}`],
  [/youtube/i, (q) => `https://www.youtube.com/results?search_query=${q}`],
  [/google play/i, (q, type) => `https://play.google.com/store/search?q=${q}&c=${type === 'tv' ? 'tv' : 'movies'}`],
];

export interface ProviderLink {
  href: string;
  /** Says where the link goes, for the tile's accessible name. */
  label: string;
}

/**
 * Where a provider tile goes: a search for the title on that service when we know how to build
 * one, otherwise TMDB's watch page, which has JustWatch's direct link for every option.
 */
export function providerLink(p: Provider, title: string, type: MediaType, fallback: string | null): ProviderLink | null {
  const name = serviceName(p.provider_name);
  const q = encodeURIComponent(title);
  const match = searchPages.find(([pattern]) => pattern.test(p.provider_name));
  if (match) return { href: match[1](q, type), label: `Search ${name} for ${title}` };
  if (fallback) return { href: fallback, label: `${name}: see the link on TMDB` };
  return null;
}
