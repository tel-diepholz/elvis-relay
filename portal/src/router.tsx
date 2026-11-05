import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';

/** Kleiner Router über die History-API (das Portal hat nur wenige Seiten) */
export function navigate(to: string): void {
  window.history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo(0, 0);
}

export function useRoute(): string {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return path;
}

export const nodeUrl = (id: string) => `/knoten/${encodeURIComponent(id)}`;

export function Link({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  const click = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} className={className} onClick={click}>
      {children}
    </a>
  );
}
