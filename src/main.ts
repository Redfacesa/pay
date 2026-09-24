import { listen, createApp } from "./http/server.ts";

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
const app = createApp({ paymentEnv, webhookSecret, adminToken, deviceToken });
const running = await listen(app, host, port);
console.log(`Red Face terminal sandbox listening on http://${host}:${running.port}`);
console.log("Terminal  http://localhost:" + running.port + "/");
console.log("Admin     http://localhost:" + running.port + "/admin");
