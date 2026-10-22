import { NotificationBell } from "./Social";
import { HealthBadge } from "./Trust13";

export function NavBar({ signedIn }: { signedIn: boolean }) {
  return (
    <nav className="nav">
      <a className="brand" href="/">
        Pit
      </a>
      <a href="/feed">Feed</a>
      <a href="/leaderboard">Leaderboard</a>
      <a href="/market">Marketplace</a>
      <a href="/studio">Studio</a>
      {signedIn && <a href="/earnings">Earnings</a>}
      {signedIn && <a href="/connections">Connections</a>}
      {signedIn && <a href="/trust">Trust</a>}
      {signedIn && <NotificationBell />}
      {signedIn && <a href="/">My account</a>}
      <HealthBadge />
    </nav>
  );
}
