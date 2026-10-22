import { useEffect, useState } from "react";

// Paths the server answers itself (link previews, images, the API): these must always be real page loads.
const SERVER_PATHS = /^\/(c|og|v1)\//;

/** The in-app path for a link, or null if the browser should handle it (another site, a server path, a file). */
export function internalPath(href: string, origin: string): string | null {
  let u: URL;
  try {
    u = new URL(href, origin);
  } catch {
    return null;
  }
  if (u.origin !== origin || SERVER_PATHS.test(u.pathname)) return null;
  return u.pathname + u.search + u.hash;
}

export function navigate(to: string) {
  if (to === window.location.pathname + window.location.search + window.location.hash) return;
  window.history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
  if (!to.includes("#")) window.scrollTo(0, 0);
}

/** The current path, kept in step with the address bar and the back button. */
export function usePath(): string {
  const [, bump] = useState(0);
  useEffect(() => {
    const on = () => bump((n) => n + 1);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return window.location.pathname;
}

/** Turns clicks on in-app links into in-app navigation, so moving around doesn't reload and rebuild the whole app. */
export function useLinkNavigation() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return;
      const a = (e.target as Element | null)?.closest?.("a");
      if (
        !a ||
        !a.getAttribute("href") ||
        (a.target && a.target !== "_self") ||
        a.hasAttribute("download")
      )
        return;
      const to = internalPath(a.href, window.location.origin);
      if (to === null) return;
      e.preventDefault();
      navigate(to);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
}
