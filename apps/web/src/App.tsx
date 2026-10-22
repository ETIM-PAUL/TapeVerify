import { useCallback, useEffect, useState } from "react";
import { api, type User } from "./api";
import { Account } from "./components/Account";
import { ArgusAdmin } from "./components/ArgusAdmin";
import { CallPage } from "./components/CallPage";
import { Connect } from "./components/Connect";
import { Earnings } from "./components/Earnings";
import { Leaderboard } from "./components/Leaderboard";
import { ListingPage } from "./components/ListingPage";
import { Market } from "./components/Market";
import { NavBar } from "./components/NavBar";
import { Profile } from "./components/Profile";
import { Studio } from "./components/Studio";
import { Trust } from "./components/Trust";
import { type ActiveWallet, WalletContext } from "./wallet-context";

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [wallet, setWallet] = useState<ActiveWallet | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api
      .get<{ user: User }>("/v1/me")
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setReady(true));
  }, []);

  const logout = useCallback(async () => {
    await api.post("/v1/auth/logout").catch(() => {});
    setUser(null);
    setWallet(null);
  }, []);

  const path = window.location.pathname;
  const callCode = path.match(/^\/call\/([A-Za-z0-9]+)$/)?.[1];
  const traderRef = path.match(/^\/t\/([A-Za-z0-9_-]+)$/)?.[1];
  const isBoard = path === "/leaderboard";
  const isStudio = path === "/studio";
  const listingId = path.match(/^\/market\/([0-9a-f-]{36})$/)?.[1];
  const isMarket = path === "/market";
  const isEarnings = path === "/earnings";
  const isTrust = path === "/trust";
  const isArgusAdmin = path === "/admin/argus";
  const publicPage = Boolean(
    callCode ||
      traderRef ||
      isBoard ||
      isStudio ||
      listingId ||
      isMarket ||
      isEarnings ||
      isArgusAdmin,
  );
  if (!ready && !publicPage) return null;
  return (
    <WalletContext.Provider value={{ wallet, setWallet }}>
      <main>
        <NavBar signedIn={Boolean(user)} />
        {callCode ? (
          <CallPage code={callCode} />
        ) : traderRef ? (
          <Profile ref_={traderRef} />
        ) : isBoard ? (
          <Leaderboard />
        ) : listingId ? (
          <ListingPage id={listingId} />
        ) : isMarket ? (
          <Market />
        ) : isEarnings ? (
          <Earnings />
        ) : isArgusAdmin ? (
          <ArgusAdmin />
        ) : isTrust && user ? (
          <Trust />
        ) : isStudio ? (
          <Studio user={user} onUser={setUser} />
        ) : user ? (
          <Account user={user} onLogout={logout} onExpired={logout} />
        ) : (
          <Connect
            onDone={(u, w) => {
              setUser(u);
              setWallet(w);
            }}
          />
        )}
      </main>
    </WalletContext.Provider>
  );
}
