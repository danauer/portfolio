import type { ReactNode } from 'react';
import { image, type Availability, type TitleSummary } from '../../lib/watch/tmdb';
import { verdict, type Tone } from '../../lib/watch/providers';

export const typeLabel = (t: TitleSummary) => (t.type === 'movie' ? 'Movie' : 'TV');
export const titleKey = (t: Pick<TitleSummary, 'type' | 'id'>) => `${t.type}-${t.id}`;

export function Poster({ title, size = 'w185', className = '' }: { title: TitleSummary; size?: 'w92' | 'w185' | 'w342'; className?: string }) {
  const src = image(title.posterPath, size);
  const big = image(title.posterPath, size === 'w92' ? 'w185' : size === 'w185' ? 'w342' : 'w500');
  return (
    <span className={`poster ${className}`}>
      {src ? (
        <img src={src} srcSet={`${src} 1x, ${big} 2x`} alt="" loading="lazy" decoding="async" />
      ) : (
        <span className="poster-empty" aria-hidden="true">
          {title.title}
        </span>
      )}
    </span>
  );
}

export function Chip({ tone, children }: { tone: Tone; children?: ReactNode }) {
  return (
    <span className="chip" data-tone={tone}>
      {children}
    </span>
  );
}

/** A search result: poster, title, and where it is. `where` is null when TMDB couldn't say. */
export function TitleRow({ title, where, mine, onOpen }: { title: TitleSummary; where: Availability | null; mine: ReadonlySet<string>; onOpen: (t: TitleSummary) => void }) {
  const v = where && verdict(where, mine);
  return (
    <li className="title-row">
      <a href={`?t=${titleKey(title)}`} onClick={(e) => openHandler(e, () => onOpen(title))}>
        <Poster title={title} size="w92" />
        <span className="row-text">
          <span className="row-title">{title.title}</span>
          <span className="row-meta">{[typeLabel(title), title.year].filter(Boolean).join(' · ')}</span>
        </span>
        {v && <Chip tone={v.tone}>{v.short}</Chip>}
      </a>
    </li>
  );
}

/** Let modified clicks (new tab, new window) through; handle plain clicks in the app. */
export function openHandler(e: React.MouseEvent, open: () => void) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  open();
}

export function Problem({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div className="problem" role="alert">
      <p>{children}</p>
      {onRetry && (
        <button type="button" className="button" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}
