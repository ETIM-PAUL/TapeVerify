export function NavBar({ signedIn }: { signedIn: boolean }) {
  return (
    <nav className="nav">
      <a className="brand" href="/">
        Pit
      </a>
      <a href="/leaderboard">Leaderboard</a>
      <a href="/studio">Studio</a>
      {signedIn && <a href="/">My account</a>}
    </nav>
  );
}
