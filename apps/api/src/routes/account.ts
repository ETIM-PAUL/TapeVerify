import { getAccount, getPositions, getTransactions, TX_TYPE } from "@tapeverify/strike-sdk";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";

export function accountRoutes(app: FastifyInstance, d: AppDeps) {
  app.get("/v1/account", { preHandler: d.requireUser }, async (req) => {
    const user = req.user!;
    const [account, positions] = await d.gateway.run(user.id, (c) =>
      Promise.all([getAccount(c), getPositions(c)]),
    );
    return { user, account, positions };
  });

  // Deposit and withdrawal history straight from Strike.
  app.get("/v1/transactions", { preHandler: d.requireUser }, async (req) => {
    const txs = await d.gateway.run(req.user!.id, (c) =>
      getTransactions(c, { types: [TX_TYPE.deposit, TX_TYPE.withdraw], limit: 50 }),
    );
    return { transactions: txs };
  });
}
