import { MemoryStore } from "./store/memory.ts";
import { DEFAULT_TERMINAL_CONFIG, type Actor } from "./domain/types.ts";

export const SANDBOX_ADMIN_TOKEN = "sandbox-admin";
export const SANDBOX_DEVICE_TOKEN = "sandbox-device-rf-term-000001";
export const DEMO_TERMINAL_ID = "RF-TERM-000001";
export const DEMO_TERMINAL_OFFLINE_ID = "RF-TERM-000002";
export const DEMO_MERCHANT_ID = "mer_demo";

export function seed(store: MemoryStore): void {
  const now = new Date().toISOString();
  store.users.set("usr_admin", {
    id: "usr_admin",
    name: "Red Face Admin",
    email: "admin@redface.local",
    phone: "",
    role: "ADMIN",
    status: "active",
    createdAt: now,
  });
  store.businesses.set("biz_demo", {
    id: "biz_demo",
    ownerId: "usr_admin",
    businessName: "Demo Store",
    registrationNumber: "2026/000001/07",
    status: "active",
    currency: "ZAR",
    country: "ZA",
    createdAt: now,
  });
  store.merchants.set(DEMO_MERCHANT_ID, {
    id: DEMO_MERCHANT_ID,
    businessId: "biz_demo",
    processorId: "sandbox",
    processorAccountId: "sandbox-demo-store",
    settlementAccount: "sandbox-settlement",
    status: "active",
  });
  store.terminals.set(DEMO_TERMINAL_ID, {
    id: DEMO_TERMINAL_ID,
    merchantId: DEMO_MERCHANT_ID,
    terminalSerial: "SIM-000001",
    deviceModel: "Red Face Simulator",
    firmwareVersion: "sim-0",
    softwareVersion: "1.0.4",
    status: "ONLINE",
    location: "Cape Town",
    lastSeen: now,
    registeredAt: now,
    config: { ...DEFAULT_TERMINAL_CONFIG },
    pendingCommand: null,
    pairingCode: null,
  });
  store.terminals.set(DEMO_TERMINAL_OFFLINE_ID, {
    id: DEMO_TERMINAL_OFFLINE_ID,
    merchantId: DEMO_MERCHANT_ID,
    terminalSerial: "SIM-000002",
    deviceModel: "Red Face Simulator",
    firmwareVersion: "sim-0",
    softwareVersion: "1.0.3",
    status: "OFFLINE",
    location: "Khayelitsha",
    lastSeen: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    registeredAt: now,
    config: { ...DEFAULT_TERMINAL_CONFIG },
    pendingCommand: null,
    pairingCode: null,
  });
  store.devices.set("dev_000001", {
    id: "dev_000001",
    terminalId: DEMO_TERMINAL_ID,
    hardwareId: "sim-hardware-1",
    osVersion: "simulator",
    firmwareVersion: "sim-0",
    appVersion: "1.0.4",
    securityStatus: "sandbox",
  });
  store.setSequence("RF-TERM-", 2);
}

export function actorsForTokens(adminToken: string, deviceToken: string): Map<string, Actor> {
  return new Map([
    [
      adminToken,
      { id: "usr_admin", role: "ADMIN", terminalId: null, merchantId: DEMO_MERCHANT_ID },
    ],
    [
      deviceToken,
      { id: DEMO_TERMINAL_ID, role: "TERMINAL", terminalId: DEMO_TERMINAL_ID, merchantId: DEMO_MERCHANT_ID },
    ],
  ]);
}
