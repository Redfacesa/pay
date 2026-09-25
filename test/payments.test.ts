import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { assertTransition } from "../src/domain/state-machine.ts";
import { PaymentEngine } from "../src/engine/payment-engine.ts";
import { SimulatorHardware } from "../src/hardware/simulator.ts";
import { SandboxProvider } from "../src/providers/sandbox.ts";
import { DEMO_TERMINAL_ID, seed } from "../src/seed.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { Actor } from "../src/domain/types.ts";
import { createApp, listen } from "../src/http/server.ts";

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
  const provider = new SandboxProvider("sandbox");
  const engine = new PaymentEngine(store, provider, { webhookSecret: "sandbox-webhook-secret" });
  return { store, provider, engine };
}

test("state machine rejects a jump from created to paid", () => {
  assert.throws(() => assertTransition("CREATED", "COMPLETED"), /CREATED to COMPLETED/);
});

test("approved tap creates one completed transaction", async () => {
  const { engine, provider } = harness();
  const sale = engine.createSale({
    actor: terminal,
    terminalId: DEMO_TERMINAL_ID,
    amount: 25000,
    currency: "ZAR",
    paymentMethod: "tap",
    idempotencyKey: "sale-approved-1",
  });
  assert.equal(sale.status, "INITIATED");
  const paid = await engine.authorize({
    actor: terminal,
    sessionId: sale.session_id ?? "",
    idempotencyKey: "pay-approved-1",
    signal: "approve",
  });
  assert.equal(paid.status, "COMPLETED");
  assert.equal(paid.amount_display, "R 250.00");
  assert.equal(provider.listCharges().length, 1);
  const replay = await engine.authorize({
    actor: terminal,
    sessionId: sale.session_id ?? "",
    idempotencyKey: "pay-approved-1",
    signal: "approve",
  });
  assert.equal(replay.id, paid.id);
  assert.equal(provider.listCharges().length, 1);
});

test("a lost response stays unknown until the provider confirms a single charge", async () => {
  const { engine, provider } = harness();
  const sale = engine.createSale({
    actor: terminal,
    terminalId: DEMO_TERMINAL_ID,
    amount: 25000,
    currency: "ZAR",
    paymentMethod: "tap",
    idempotencyKey: "sale-unknown-1",
  });
  const unknown = await engine.authorize({
    actor: terminal,
    sessionId: sale.session_id ?? "",
    idempotencyKey: "pay-unknown-1",
    signal: "network_error",
  });
  assert.equal(unknown.status, "UNKNOWN");
  assert.equal(provider.listCharges().length, 1);
  const report = engine.reconciliation();
  assert.equal(report.exceptions.some((item) => item.state === "STATUS_MISMATCH"), true);

  const replay = await engine.authorize({
    actor: terminal,
    sessionId: sale.session_id ?? "",
    idempotencyKey: "pay-unknown-1",
    signal: "network_error",
  });
  assert.equal(replay.id, unknown.id);
  assert.equal(provider.listCharges().length, 1);

  const resolved = await engine.resolve({ actor: admin, transactionId: unknown.id });
  assert.equal(resolved.status, "COMPLETED");
  const after = engine.reconciliation();
  assert.equal(after.exceptions.length, 0);
  assert.equal(after.provider_count, 1);
  assert.equal(after.redface_count, 1);
});

test("webhook signature is required and a signed completion resolves unknown", async () => {
  const { engine } = harness();
  const sale = engine.createSale({
    actor: terminal,
    terminalId: DEMO_TERMINAL_ID,
    amount: 5000,
    currency: "ZAR",
    paymentMethod: "card",
    idempotencyKey: "sale-webhook-1",
  });
  const unknown = await engine.authorize({
    actor: terminal,
    sessionId: sale.session_id ?? "",
    idempotencyKey: "pay-webhook-1",
    signal: "network_error",
  });
  const body = JSON.stringify({
    id: "evt_1",
    type: "payment.completed",
    data: { reference: unknown.processor_reference, amount: 5000, currency: "ZAR" },
  });
  assert.throws(() => engine.ingestWebhook(body, "deadbeef"), /signature/i);
  const signature = createHmac("sha256", "sandbox-webhook-secret").update(body).digest("hex");
  const first = engine.ingestWebhook(body, signature);
  assert.equal(first.transaction?.status, "COMPLETED");
  const second = engine.ingestWebhook(body, signature);
  assert.equal(second.duplicate, true);
});

test("cash works offline and card does not", () => {
  const { engine, store } = harness();
  const device = store.terminals.get(DEMO_TERMINAL_ID);
  assert.ok(device);
  device.status = "OFFLINE";
  assert.throws(
    () =>
      engine.createSale({
        actor: terminal,
        terminalId: DEMO_TERMINAL_ID,
        amount: 1000,
        currency: "ZAR",
        paymentMethod: "tap",
        idempotencyKey: "sale-offline-card",
      }),
    /Cash sale available/,
  );
  const cash = engine.createSale({
    actor: terminal,
    terminalId: DEMO_TERMINAL_ID,
    amount: 1000,
    currency: "ZAR",
    paymentMethod: "cash",
    idempotencyKey: "sale-offline-cash",
  });
  assert.equal(cash.status, "COMPLETED");
  assert.equal(cash.processor, "cash");
});

test("refunds move through partial and full without exceeding the capture", async () => {
  const { engine } = harness();
  const sale = engine.createSale({
    actor: terminal,
    terminalId: DEMO_TERMINAL_ID,
    amount: 25000,
    currency: "ZAR",
    paymentMethod: "tap",
    idempotencyKey: "sale-refund-1",
  });
  const paid = await engine.authorize({
    actor: terminal,
    sessionId: sale.session_id ?? "",
    idempotencyKey: "pay-refund-1",
    signal: "approve",
  });
  const partial = await engine.refund({
    actor: admin,
    transactionId: paid.id,
    amount: 10000,
    reason: "Customer returned part of the sale",
    idempotencyKey: "refund-partial-1",
  });
  assert.equal(partial.status, "PARTIALLY_REFUNDED");
  const full = await engine.refund({
    actor: admin,
    transactionId: paid.id,
    amount: 15000,
    reason: "Customer returned the rest",
    idempotencyKey: "refund-full-1",
  });
  assert.equal(full.status, "REFUNDED");
  await assert.rejects(
    () =>
      engine.refund({
        actor: admin,
        transactionId: paid.id,
        amount: 100,
        reason: "Too much",
        idempotencyKey: "refund-over-1",
      }),
    /remaining/,
  );
});

test("same idempotency key with a different amount is rejected", () => {
  const { engine } = harness();
  engine.createSale({
    actor: terminal,
    terminalId: DEMO_TERMINAL_ID,
    amount: 25000,
    currency: "ZAR",
    paymentMethod: "cash",
    idempotencyKey: "sale-same-key",
  });
  assert.throws(
    () =>
      engine.createSale({
        actor: terminal,
        terminalId: DEMO_TERMINAL_ID,
        amount: 26000,
        currency: "ZAR",
        paymentMethod: "cash",
        idempotencyKey: "sale-same-key",
      }),
    /different request/,
  );
});

test("simulator hardware does not return card data", async () => {
  const hardware = new SimulatorHardware();
  const result = await hardware.presentCard("approve");
  assert.deepEqual(Object.keys(result), ["presented"]);
});

test("sandbox provider refuses production and an orphan charge is an exception", () => {
  assert.throws(() => new SandboxProvider("production"), /production/);
  const { engine, provider } = harness();
  provider.injectOrphan(900, "ZAR");
  const report = engine.reconciliation();
  assert.equal(report.exceptions[0]?.state, "MISSING_REDFACE");
});

test("http webhook and overview show the paid sale", async () => {
  const app = createApp({
    paymentEnv: "sandbox",
    webhookSecret: "sandbox-webhook-secret",
    adminToken: "sandbox-admin",
    deviceToken: "sandbox-device-rf-term-000001",
    simcloudToken: "",
  });
  const running = await listen(app, "127.0.0.1", 0);
  try {
    const saleResponse = await fetch(`http://127.0.0.1:${running.port}/api/v1/sales`, {
      method: "POST",
      headers: {
        authorization: "Bearer sandbox-device-rf-term-000001",
        "content-type": "application/json",
        "idempotency-key": "http-sale-1",
      },
      body: JSON.stringify({
        terminal_id: "RF-TERM-000001",
        amount: 25000,
        currency: "ZAR",
        payment_method: "tap",
      }),
    });
    assert.equal(saleResponse.status, 200);
    const sale = await saleResponse.json();
    const paidResponse = await fetch(`http://127.0.0.1:${running.port}/api/v1/payment-sessions/${sale.session_id}/authorize`, {
      method: "POST",
      headers: {
        authorization: "Bearer sandbox-device-rf-term-000001",
        "content-type": "application/json",
        "idempotency-key": "http-pay-1",
      },
      body: JSON.stringify({ signal: "approve" }),
    });
    assert.equal(paidResponse.status, 200);
    const overview = await fetch(`http://127.0.0.1:${running.port}/api/v1/reports/overview`, {
      headers: { authorization: "Bearer sandbox-admin" },
    });
    const body = await overview.json();
    assert.equal(body.volume, 25000);
    assert.equal(body.successful, 1);
    const page = await fetch(`http://127.0.0.1:${running.port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /class="brand">PAY</);
  } finally {
    await new Promise<void>((resolve, reject) => {
      running.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
