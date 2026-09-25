import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listen, createApp } from "./http/server.ts";

loadEnv();

const paymentEnv = process.env.PAYMENT_ENV ?? "sandbox";
const webhookSecret = process.env.SANDBOX_WEBHOOK_SECRET ?? "sandbox-webhook-secret";
const adminToken = process.env.ADMIN_TOKEN ?? "sandbox-admin";
const deviceToken = process.env.DEVICE_TOKEN ?? "sandbox-device-rf-term-000001";

if (paymentEnv === "production") {
  const sandboxCredential =
    webhookSecret === "sandbox-webhook-secret" ||
    adminToken === "sandbox-admin" ||
    deviceToken.startsWith("sandbox-");
  if (sandboxCredential) {
    throw new Error("Refusing to start production with sandbox credentials.");
  }
}

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 8787);
const app = createApp({
  paymentEnv,
  webhookSecret,
  adminToken,
  deviceToken,
  simcloudToken: process.env.SIMCLOUD_TOKEN ?? "",
});
const running = await listen(app, host, port);
console.log(`Red Face terminal sandbox listening on http://${host}:${running.port}`);
console.log("Terminal  http://localhost:" + running.port + "/");
console.log("Admin     http://localhost:" + running.port + "/admin");
console.log("Services  " + (process.env.SIMCLOUD_TOKEN ? "SIMcloud" : "simulator"));

function loadEnv(): void {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env");
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
