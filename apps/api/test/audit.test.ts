import { describe, expect, it } from "vitest";
import { makeApp, type TestApp } from "./helpers.js";

const ACCOUNT = "01a16485-b6ee-7745-ba83-88fa7d0d9b00";
const post = (t: TestApp, query: unknown) =>
  t.app.inject({ method: "POST", url: "/v1/audits", payload: { query } });

describe("fair-execution audit requests", () => {
  it("accepts an account id, a vault id or an address, and refuses anything else", async () => {
    const t = await makeApp();
    await t.pool.query("DELETE FROM audit_jobs");
    for (const bad of ["", "hello", "0x123", 42]) expect((await post(t, bad)).statusCode).toBe(400);
    const r = await post(t, ACCOUNT);
    expect(r.statusCode).toBe(202);
    expect(r.json().reused).toBe(false);
    const eth = await post(t, `0x${"ab".repeat(20)}`);
    expect(eth.statusCode).toBe(202);
    await t.close();
  });

  it("gives a repeat request the audit already asked for", async () => {
    const t = await makeApp();
    await t.pool.query("DELETE FROM audit_jobs");
    const first = (await post(t, ACCOUNT)).json();
    const again = await post(t, ` ${ACCOUNT.toUpperCase()} `);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ id: first.id, reused: true });
    expect((await t.pool.query("SELECT count(*) AS n FROM audit_jobs")).rows[0].n).toBe("1");
    await t.close();
  });

  it("shows an audit's progress, then its report", async () => {
    const t = await makeApp();
    await t.pool.query("DELETE FROM audit_jobs");
    const { id } = (await post(t, ACCOUNT)).json();
    const waiting = (await t.app.inject({ method: "GET", url: `/v1/audits/${id}` })).json();
    expect(waiting).toMatchObject({ id, status: "queued", report: null, error: null });
    const report = { version: 1, verdict: "clean" };
    await t.pool.query("UPDATE audit_jobs SET status = 'done', report = $2 WHERE id = $1", [
      id,
      JSON.stringify(report),
    ]);
    const done = (await t.app.inject({ method: "GET", url: `/v1/audits/${id}` })).json();
    expect(done).toMatchObject({ status: "done", report });
    expect((await t.app.inject({ method: "GET", url: "/v1/audits/not-an-id" })).statusCode).toBe(
      400,
    );
    expect(
      (
        await t.app.inject({
          method: "GET",
          url: "/v1/audits/11111111-1111-4111-8111-111111111111",
        })
      ).statusCode,
    ).toBe(404);
    await t.close();
  });

  it("turns new requests away when too many are waiting", async () => {
    const t = await makeApp();
    await t.pool.query("DELETE FROM audit_jobs");
    for (let i = 0; i < 25; i++)
      await t.pool.query(
        "INSERT INTO audit_jobs (selector, selector_key, created_ms) VALUES ('{}', $1, $2)",
        [`id:filler-${i}`, Date.now()],
      );
    const r = await post(t, ACCOUNT);
    expect(r.statusCode).toBe(503);
    expect(r.json().code).toBe("busy");
    await t.pool.query("DELETE FROM audit_jobs");
    await t.close();
  });
});
