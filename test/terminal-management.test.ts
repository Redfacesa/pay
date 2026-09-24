import assert from "node:assert/strict";
import test from "node:test";
import type { Actor } from "../src/domain/types.ts";
import { PaymentEngine } from "../src/engine/payment-engine.ts";
import { SandboxProvider } from "../src/providers/sandbox.ts";
import { DEMO_TERMINAL_ID, seed } from "../src/seed.ts";
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
  const provider = new SandboxProvider("sandbox");
  const engine = new PaymentEngine(store, provider, { webhookSecret: "sandbox-webhook-secret" });
  return { store, engine };
}

function beat(engine: PaymentEngine, times = 1) {
  let view: Record<string, unknown> = {};
  for (let index = 0; index < times; index += 1) {
    view = engine.heartbeat({ actor: terminal, terminalId: DEMO_TERMINAL_ID, online: true });
  }
  return view;
}

test("remote configuration disables tap on the terminal", () => {
  const { engine } = harness();
  engine.updateConfig({
    actor: admin,
    terminalId: DEMO_TERMINAL_ID,
    patch: { contactless_enabled: false },
  });
  assert.throws(
    () =>
      engine.createSale({
        actor: terminal,
        terminalId: DEMO_TERMINAL_ID,
        amount: 25000,
        currency: "ZAR",
        paymentMethod: "tap",
        idempotencyKey: "sale-tap-disabled",
      }),
    /Tap is disabled/,
  );
  const cash = engine.createSale({
    actor: terminal,
    terminalId: DEMO_TERMINAL_ID,
    amount: 25000,
    currency: "ZAR",
    paymentMethod: "cash",
    idempotencyKey: "sale-cash-still-on",
  });
  assert.equal(cash.status, "COMPLETED");
});

test("a software release installs only after download, verify, install, and health check", () => {
  const { engine } = harness();
  engine.publishRelease({
    actor: admin,
    terminalId: DEMO_TERMINAL_ID,
    version: "1.0.5",
    notes: "Sandbox release",
  });
  const finished = beat(engine, 7);
  assert.equal(finished.software_version, "1.0.5");
  assert.equal(finished.status, "ONLINE");
  const job = finished.update_job as { status: string };
  assert.equal(job.status, "COMPLETED");
  const messages = engine.listLogs(admin, DEMO_TERMINAL_ID).map((entry) => entry.message);
  assert.equal(messages.some((message) => message.includes("Downloading")), true);
  assert.equal(messages.some((message) => message.includes("Downloaded")), true);
  assert.equal(messages.some((message) => message.includes("Verifying")), true);
  assert.equal(messages.some((message) => message.includes("Verified")), true);
  assert.equal(messages.some((message) => message.includes("Installing")), true);
  assert.equal(messages.some((message) => message.includes("Health check")), true);
});

test("a bad package hash rolls the terminal back to the previous version", () => {
  const { engine } = harness();
  engine.publishRelease({
    actor: admin,
    terminalId: DEMO_TERMINAL_ID,
    version: "1.0.5",
    notes: "Broken package",
    corrupt: true,
  });
  const finished = beat(engine, 4);
  assert.equal(finished.software_version, "1.0.4");
  const job = finished.update_job as { status: string; previous_version: string };
  assert.equal(job.status, "ROLLED_BACK");
  assert.equal(job.previous_version, "1.0.4");
});

test("a failed health check rolls back", () => {
  const { engine } = harness();
  engine.publishRelease({
    actor: admin,
    terminalId: DEMO_TERMINAL_ID,
    version: "1.0.6",
    notes: "Fails health",
    failHealth: true,
  });
  const finished = beat(engine, 7);
  assert.equal(finished.software_version, "1.0.4");
  assert.equal((finished.update_job as { status: string }).status, "ROLLED_BACK");
});

test("auto-update off leaves the release queued", () => {
  const { engine } = harness();
  engine.updateConfig({ actor: admin, terminalId: DEMO_TERMINAL_ID, patch: { auto_update: false } });
  const queued = engine.publishRelease({
    actor: admin,
    terminalId: DEMO_TERMINAL_ID,
    version: "1.0.5",
    notes: "Held release",
  });
  assert.equal((queued.update_job as { status: string }).status, "UPDATE_DETECTED");
  const after = beat(engine, 2);
  assert.equal(after.software_version, "1.0.4");
  assert.equal((after.update_job as { status: string }).status, "UPDATE_DETECTED");
});

test("a new terminal pairs and then heartbeats with its own token", () => {
  const { engine, store } = harness();
  const created = engine.registerTerminal({
    actor: admin,
    location: "Stellenbosch",
    deviceModel: "Red Face Simulator",
  });
  const code = String(created.pairing_code);
  const paired = engine.pairTerminal(code);
  assert.equal(paired.terminal_id, created.id);
  assert.throws(() => engine.pairTerminal(code), /not found/i);
  const actor = store.deviceTokens.get(paired.device_token);
  assert.ok(actor);
  const view = engine.heartbeat({ actor, terminalId: paired.terminal_id, online: true });
  assert.equal(view.status, "ONLINE");
  assert.equal(view.location, "Stellenbosch");
});

test("locking a terminal blocks sales and survives a heartbeat", () => {
  const { engine } = harness();
  engine.command({ actor: admin, terminalId: DEMO_TERMINAL_ID, action: "lock" });
  assert.throws(
    () =>
      engine.createSale({
        actor: terminal,
        terminalId: DEMO_TERMINAL_ID,
        amount: 1000,
        currency: "ZAR",
        paymentMethod: "cash",
        idempotencyKey: "sale-while-locked",
      }),
    /cannot take payments/,
  );
  const view = engine.heartbeat({ actor: terminal, terminalId: DEMO_TERMINAL_ID, online: true });
  assert.equal(view.status, "LOCKED");
});

test("merchant overview reports terminals and today's sales", () => {
  const { engine } = harness();
  engine.createSale({
    actor: terminal,
    terminalId: DEMO_TERMINAL_ID,
    amount: 25000,
    currency: "ZAR",
    paymentMethod: "cash",
    idempotencyKey: "sale-merchant-1",
  });
  const merchant = engine.getMerchant(admin, "mer_demo");
  assert.equal(merchant.business_name, "Demo Store");
  assert.equal((merchant.today as { volume: number }).volume, 25000);
  assert.equal((merchant.terminals as unknown[]).length, 2);
});

test("terminal detail includes health, software, and audit", () => {
  const { engine } = harness();
  const detail = engine.getTerminalDetail(admin, DEMO_TERMINAL_ID);
  assert.equal(detail.id, DEMO_TERMINAL_ID);
  assert.equal((detail.health as { application: string }).application, "HEALTHY");
  assert.equal((detail.software as { current_version: string }).current_version, "1.0.4");
  assert.ok(Array.isArray(detail.audit));
});

test("revoke disables the terminal and rejects the paired device token", () => {
  const { engine, store } = harness();
  const created = engine.registerTerminal({
    actor: admin,
    location: "Paarl",
    deviceModel: "Red Face Simulator",
  });
  const paired = engine.pairTerminal(String(created.pairing_code));
  engine.command({ actor: admin, terminalId: paired.terminal_id, action: "revoke" });
  assert.equal(store.deviceTokens.has(paired.device_token), false);
  const detail = engine.getTerminalDetail(admin, paired.terminal_id);
  assert.equal(detail.status, "DISABLED");
  assert.equal((detail.health as { application: string }).application, "REVOKED");
});

test("provider failure and cancel complete without charging", async () => {
  const { engine } = harness();
  const sale = engine.createSale({
    actor: terminal,
    terminalId: DEMO_TERMINAL_ID,
    amount: 25000,
    currency: "ZAR",
    paymentMethod: "tap",
    idempotencyKey: "sale-fail-1",
  });
  const failed = await engine.authorize({
    actor: terminal,
    sessionId: sale.session_id ?? "",
    idempotencyKey: "pay-fail-1",
    signal: "provider_failure",
  });
  assert.equal(failed.status, "FAILED");
  assert.equal(engine.providerCharges().length, 0);

  const sale2 = engine.createSale({
    actor: terminal,
    terminalId: DEMO_TERMINAL_ID,
    amount: 25000,
    currency: "ZAR",
    paymentMethod: "card",
    idempotencyKey: "sale-cancel-1",
  });
  const cancelled = await engine.authorize({
    actor: terminal,
    sessionId: sale2.session_id ?? "",
    idempotencyKey: "pay-cancel-1",
    signal: "cancel",
  });
  assert.equal(cancelled.status, "CANCELLED");
});
