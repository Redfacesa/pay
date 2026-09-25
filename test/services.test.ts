import assert from "node:assert/strict";
import test from "node:test";
import type { Actor } from "../src/domain/types.ts";
import { DEMO_TERMINAL_ID, seed } from "../src/seed.ts";
import { ServiceEngine } from "../src/services/engine.ts";
import { ServiceSimulator } from "../src/services/simulator.ts";
import { MemoryStore } from "../src/store/memory.ts";

const terminal: Actor = {
  id: DEMO_TERMINAL_ID,
  role: "TERMINAL",
  terminalId: DEMO_TERMINAL_ID,
  merchantId: "mer_demo",
};
const admin: Actor = {
  id: "usr_admin",
  role: "ADMIN",
  terminalId: null,
  merchantId: "mer_demo",
};

function harness() {
  const store = new MemoryStore();
  seed(store);
  const provider = new ServiceSimulator("sandbox");
  const services = new ServiceEngine(store, provider);
  return { services, provider };
}

test("airtime completes with provider cost and Red Face margin", async () => {
  const { services, provider } = harness();
  const order = await services.create(
    terminal,
    { serviceType: "AIRTIME", amount: 2000, msisdn: "0831234567" },
    "airtime-key-1",
  );
  assert.equal(order.status, "COMPLETED");
  assert.equal(order.network, "MTN");
  assert.equal(order.amount, 2000);
  assert.equal(order.cost, 1850);
  assert.equal(order.margin, 150);
  assert.match(String(order.provider_reference), /^SIMCLOUD-SIM-/);
  assert.equal((await provider.health()).balance, 1_000_000 - 1850);
  const replay = await services.create(
    terminal,
    { serviceType: "AIRTIME", amount: 2000, msisdn: "0831234567" },
    "airtime-key-1",
  );
  assert.equal(replay.id, order.id);
  assert.equal((await provider.health()).balance, 1_000_000 - 1850);
});

test("pending airtime is polled once to success", async () => {
  const { services, provider } = harness();
  const order = await services.create(
    terminal,
    { serviceType: "AIRTIME", amount: 2000, msisdn: "0821234567", simulation: "pending" },
    "airtime-pending",
  );
  assert.equal(order.status, "PENDING");
  assert.equal((await provider.health()).balance, 1_000_000);
  const done = await services.poll(terminal, order.id);
  assert.equal(done.status, "COMPLETED");
  assert.equal(done.network, "VODACOM");
  assert.equal((await provider.health()).balance, 1_000_000 - 1850);
});

test("electricity validates the meter and returns a voucher", async () => {
  const { services } = harness();
  const invalid = await services.checkMeter(terminal, "01234567");
  assert.equal(invalid.valid, false);
  const valid = await services.checkMeter(terminal, "12345678");
  assert.equal(valid.valid, true);
  const order = await services.create(
    terminal,
    { serviceType: "ELECTRICITY", amount: 15000, meterNumber: "12345678" },
    "elec-key-1",
  );
  assert.equal(order.status, "COMPLETED");
  assert.equal(order.voucher, "1234 5678 9012 3456");
  assert.ok(order.units);
});

test("provider error records the order and does not debit the wallet", async () => {
  const { services, provider } = harness();
  const order = await services.create(
    terminal,
    { serviceType: "AIRTIME", amount: 2000, msisdn: "0831234567", simulation: "provider_error" },
    "airtime-down",
  );
  assert.equal(order.status, "PROVIDER_ERROR");
  assert.equal(order.cost, 0);
  assert.equal((await provider.health()).balance, 1_000_000);
  assert.equal(services.list(terminal).length, 1);
});

test("data uses the catalogue and operations can see the simulator wallet", async () => {
  const { services } = harness();
  const products = await services.products(terminal, "DATA");
  assert.equal(products.length, 3);
  const order = await services.create(
    terminal,
    { serviceType: "DATA", msisdn: "0841234567", productId: "dat_cellc_1gb" },
    "data-key-1",
  );
  assert.equal(order.network, "CELLC");
  assert.equal(order.amount, 2500);
  const health = await services.providerHealth(admin);
  assert.equal(health.provider, "simulator");
  assert.equal(health.electricity, "ONLINE");
  assert.equal("token" in health, false);
});
