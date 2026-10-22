import { useEffect, useRef, useState } from "react";
import type { User } from "../api";
import { shortAddr } from "../format";
import { usePath } from "../router";
import { LogoMark, Wordmark } from "./Logo";
import { NotificationBell } from "./Social";
import { Ticker } from "./Ticker";
import { HealthBadge } from "./Trust13";

const LINKS: Array<[string, string]> = [
  ["/feed", "Feed"],
  ["/leaderboard", "Leaderboard"],
  ["/market", "Marketplace"],
  ["/studio", "Studio"],
  ["/verify", "Verify"],
];

const MENU: Array<[string, string]> = [
  ["/", "My account"],
  ["/earnings", "Earnings"],
  ["/subscriptions", "Subscriptions"],
  ["/guardrails", "Copy guardrails"],
  ["/connections", "Connections"],
  ["/trust", "Trust record"],
];

/** A stable colour per address, so the avatar is recognisable without being a stock icon. */
function hue(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function AccountMenu({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const name = user.handle ?? shortAddr(user.address);
  return (
    <div className="menu" ref={box}>
      <button
        type="button"
        className="menu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="avatar" style={{ background: `hsl(${hue(user.address)} 70% 62%)` }}>
          {(user.handle ?? user.address).replace(/^0x/, "").slice(0, 2).toUpperCase()}
        </span>
        {name}
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          <div className="who">
            <b>{name}</b>
            <div className="muted small">
              {user.chain} · {shortAddr(user.address)}
            </div>
          </div>
          {MENU.map(([href, label]) => (
            <a key={href} href={href} role="menuitem">
              {label}
            </a>
          ))}
          <div className="sep" />
          <button type="button" className="out" role="menuitem" onClick={onLogout}>
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

export function NavBar({ user, onLogout }: { user: User | null; onLogout: () => void }) {
  const path = usePath();
  return (
    <header className="topbar">
      <div className="topbar-in">
        <a className="brand" href="/">
          <LogoMark />
          <Wordmark />
        </a>
        <nav className="navlinks" aria-label="Main">
          {LINKS.map(([href, label]) => (
            <a
              key={href}
              href={href}
              aria-current={path === href || path.startsWith(`${href}/`) ? "page" : undefined}
            >
              {label}
            </a>
          ))}
        </nav>
        <div className="nav-right">
          <HealthBadge />
          {user ? (
            <>
              <NotificationBell />
              <AccountMenu user={user} onLogout={onLogout} />
            </>
          ) : (
            <a className="connect-link" href="/">
              Connect wallet
            </a>
          )}
        </div>
      </div>
      <Ticker />
    </header>
  );
}
