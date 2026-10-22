/** The mark: a ticker tape with a check. Drawn once and reused, so it stays sharp at any size. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <rect x="6.5" y="7" width="13" height="2.6" rx="1.3" fill="var(--accent-ink)" opacity="0.5" />
      <rect x="6.5" y="12" width="8" height="2.6" rx="1.3" fill="var(--accent-ink)" opacity="0.5" />
      <path
        d="M8 21.5 13.2 26 25.5 11.5"
        fill="none"
        stroke="var(--accent-ink)"
        strokeWidth="3.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      Tape<span>Verify</span>
    </span>
  );
}
