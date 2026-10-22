import { useCallback, useEffect, useState } from "react";
import { api, type User } from "./api";
import { Account } from "./components/Account";
import { Connect } from "./components/Connect";
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

  if (!ready) return null;
  return (
    <WalletContext.Provider value={{ wallet, setWallet }}>
      <main>
        {user ? (
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
