import { useCallback, useEffect, useState, type DependencyList } from 'react';
import type { MediaType } from '../../lib/watch/tmdb';

export type Async<T> =
  | { status: 'loading'; data?: undefined; retry: () => void }
  | { status: 'error'; data?: undefined; retry: () => void }
  | { status: 'done'; data: T; retry: () => void };

/** Runs a request whenever `deps` change and keeps only the latest answer. Pass `enabled: false` to wait. */
export function useAsync<T>(run: () => Promise<T>, deps: DependencyList, enabled = true): Async<T> {
  const [state, setState] = useState<{ status: 'loading' | 'error' | 'done'; data?: T }>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setState((s) => (s.status === 'loading' && !s.data ? s : { status: 'loading' }));
    run().then(
      (data) => live && setState({ status: 'done', data }),
      () => live && setState({ status: 'error' }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, attempt, enabled]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry } as Async<T>;
}

/** State saved in localStorage, kept in step across tabs. */
export function useStored<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const read = () => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  };
  const [value, setValue] = useState<T>(read);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === key && setValue(read());
    addEventListener('storage', onStorage);
    return () => removeEventListener('storage', onStorage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = useCallback(
    (next: T | ((prev: T) => T)) =>
      setValue((prev) => {
        const v = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        try {
          localStorage.setItem(key, JSON.stringify(v));
        } catch {
          // Private mode or full storage: the choice still holds for this visit.
        }
        return v;
      }),
    [key],
  );
  return [value, set];
}

export type Route =
  | { view: 'home' }
  | { view: 'search'; q: string }
  | { view: 'title'; type: MediaType; id: number };

function readRoute(): Route {
  const params = new URLSearchParams(location.search);
  const t = params.get('t')?.match(/^(movie|tv)-(\d+)$/);
  if (t) return { view: 'title', type: t[1] as MediaType, id: Number(t[2]) };
  const q = params.get('q')?.trim();
  return q ? { view: 'search', q } : { view: 'home' };
}

function routeUrl(route: Route) {
  const url = new URL(location.href);
  url.search = '';
  if (route.view === 'title') url.searchParams.set('t', `${route.type}-${route.id}`);
  if (route.view === 'search') url.searchParams.set('q', route.q);
  return url.pathname + url.search;
}

/**
 * The page's own views (home, a search, a title) live in the query string, so they can be linked
 * to and the browser's Back button steps through them. The site's client-side router would treat
 * those history entries as page changes and refetch the page, so on this page we catch `popstate`
 * first (a capture listener on window runs before the router's) and handle it ourselves.
 * Entries we add copy the router's state (its history index), so its own navigation keeps working.
 */
export function useRoute(): [Route, (next: Route, opts?: { replace?: boolean }) => void, boolean] {
  const [route, setRoute] = useState<Route>(readRoute);
  const [depth, setDepth] = useState<number>(() => history.state?.wtwDepth ?? 0);

  useEffect(() => {
    const path = location.pathname;
    const onPop = (e: PopStateEvent) => {
      // Only entries of this page, and only while the app is still on the page (not mid-swap away).
      if (location.pathname !== path || !document.querySelector('[data-wtw-app]')) return;
      e.stopImmediatePropagation();
      setRoute(readRoute());
      setDepth(history.state?.wtwDepth ?? 0);
      const y = history.state?.scrollY ?? 0;
      requestAnimationFrame(() => scrollTo({ top: y, behavior: 'instant' }));
    };
    addEventListener('popstate', onPop, { capture: true });
    return () => removeEventListener('popstate', onPop, { capture: true });
  }, []);

  const go = useCallback((next: Route, { replace = false } = {}) => {
    const current = history.state ?? {};
    const nextDepth = (current.wtwDepth ?? 0) + (replace ? 0 : 1);
    const state = { ...current, wtwDepth: nextDepth, scrollX: 0, scrollY: replace ? current.scrollY ?? 0 : 0 };
    if (replace) history.replaceState(state, '', routeUrl(next));
    else {
      // Remember where we were on the page we're leaving, for Back.
      history.replaceState({ ...current, scrollX, scrollY }, '');
      history.pushState(state, '', routeUrl(next));
      scrollTo({ top: 0, behavior: 'instant' });
    }
    setRoute(next);
    setDepth(nextDepth);
  }, []);

  // `depth > 0` means Back stays on this page, so a Back button can use the browser's history.
  return [route, go, depth > 0];
}
