import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppError, isAppError } from "../domain/errors.ts";
import type { Actor } from "../domain/types.ts";
import { PaymentEngine } from "../engine/payment-engine.ts";
import { SandboxProvider } from "../providers/sandbox.ts";
import { ServiceEngine } from "../services/engine.ts";
import { SimcloudProvider } from "../services/simcloud.ts";
import { ServiceSimulator } from "../services/simulator.ts";
import { actorsForTokens, seed } from "../seed.ts";
import { MemoryStore } from "../store/memory.ts";

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public");

export type AppConfig = {
  paymentEnv: string;
  webhookSecret: string;
  adminToken: string;
  deviceToken: string;
  simcloudToken: string;
};

export type App = {
  engine: PaymentEngine;
  services: ServiceEngine;
  provider: SandboxProvider;
  actors: Map<string, Actor>;
  config: AppConfig;
};

export function createApp(config: AppConfig): App {
  const store = new MemoryStore();
  seed(store);
  const provider = new SandboxProvider(config.paymentEnv);
  const engine = new PaymentEngine(store, provider, {
    webhookSecret: config.webhookSecret,
    faultInjection: config.paymentEnv !== "production",
  });
  const serviceProvider = config.simcloudToken
    ? new SimcloudProvider(config.simcloudToken)
    : new ServiceSimulator(config.paymentEnv);
  const services = new ServiceEngine(store, serviceProvider);
  return {
    engine,
    services,
    provider,
    actors: actorsForTokens(config.adminToken, config.deviceToken),
    config,
  };
}

type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  app: App;
  params: Record<string, string>;
};

export function listen(app: App, host: string, port: number): Promise<{ server: Server; port: number }> {
  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, app).catch((error: unknown) => {
      sendError(res, error);
    });
  };
  const server = createServer(onRequest);
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      if (host === "0.0.0.0") {
        const ipv6 = createServer(onRequest);
        ipv6.on("error", () => {
          ipv6.close();
        });
        ipv6.listen(actual, "::");
      }
      resolve({ server, port: actual });
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, app: App): Promise<void> {
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const ctx: Ctx = { req, res, url, app, params: {} };
  const method = req.method ?? "GET";
  const pathname = url.pathname;

  if (method === "GET" && pathname === "/health") {
    send(res, 200, { ok: true, service: "redface-pay-terminal", payment_env: app.config.paymentEnv });
    return;
  }
  if (method === "GET" && pathname === "/api/v1/sandbox/bootstrap") {
    if (app.config.paymentEnv === "production") {
      throw new AppError("NOT_FOUND", "Not found.", 404);
    }
    send(res, 200, {
      payment_env: "sandbox",
      admin_token: app.config.adminToken,
      device_token: app.config.deviceToken,
      terminal_id: "RF-TERM-000001",
      merchant_name: "Demo Store",
      service_provider: app.services.providerName(),
      note: "Sandbox credentials. Card numbers, PINs, and CVVs are not accepted. The service provider token stays on the server.",
    });
    return;
  }

  const route = matchRoute(method, pathname);
  if (route) {
    ctx.params = route.params;
    if (route.kind === "webhook") {
      const raw = await readRaw(req);
      const signature = header(req, "x-redface-signature");
      send(res, 200, app.engine.ingestWebhook(raw, signature));
      return;
    }
    if (route.kind === "pair") {
      if (app.config.paymentEnv === "production") throw new AppError("NOT_FOUND", "Not found.", 404);
      const body = await readJson(req);
      send(res, 200, app.engine.pairTerminal(String(body.code ?? "")));
      return;
    }
    const actor = authenticate(req, app);
    const body = method === "GET" ? {} : await readJson(req);
    send(res, 200, await dispatch(route.name, ctx, actor, body));
    return;
  }

  if (method === "GET") {
    await serveStatic(pathname, res);
    return;
  }
  throw new AppError("NOT_FOUND", "Not found.", 404);
}

function matchRoute(method: string, pathname: string): { name: string; params: Record<string, string>; kind?: "webhook" | "pair" } | null {
  const routes: Array<{ method: string; pattern: string; name: string; kind?: "webhook" | "pair" }> = [
    { method: "POST", pattern: "/api/v1/sales", name: "createSale" },
    { method: "POST", pattern: "/api/v1/payment-sessions/:id/authorize", name: "authorize" },
    { method: "POST", pattern: "/api/v1/payment-sessions/:id/cancel", name: "cancel" },
    { method: "POST", pattern: "/api/v1/transactions/:id/resolve", name: "resolve" },
    { method: "GET", pattern: "/api/v1/transactions/:id", name: "getTransaction" },
    { method: "GET", pattern: "/api/v1/transactions", name: "listTransactions" },
    { method: "POST", pattern: "/api/v1/refunds", name: "refund" },
    { method: "GET", pattern: "/api/v1/terminals/:id/detail", name: "terminalDetail" },
    { method: "GET", pattern: "/api/v1/terminals/:id/logs", name: "logs" },
    { method: "POST", pattern: "/api/v1/terminals/:id/releases", name: "release" },
    { method: "GET", pattern: "/api/v1/terminals/:id/config", name: "getConfig" },
    { method: "PUT", pattern: "/api/v1/terminals/:id/config", name: "putConfig" },
    { method: "POST", pattern: "/api/v1/terminals/:id/heartbeat", name: "heartbeat" },
    { method: "POST", pattern: "/api/v1/terminals/:id/commands", name: "command" },
    { method: "POST", pattern: "/api/v1/terminals/pair", name: "pair", kind: "pair" },
    { method: "POST", pattern: "/api/v1/terminals", name: "registerTerminal" },
    { method: "GET", pattern: "/api/v1/terminals/:id", name: "getTerminal" },
    { method: "GET", pattern: "/api/v1/terminals", name: "listTerminals" },
    { method: "GET", pattern: "/api/v1/merchants/:id", name: "getMerchant" },
    { method: "GET", pattern: "/api/v1/merchants", name: "listMerchants" },
    { method: "GET", pattern: "/api/v1/reports/overview", name: "overview" },
    { method: "GET", pattern: "/api/v1/settlements", name: "settlements" },
    { method: "GET", pattern: "/api/v1/reconciliation", name: "reconciliation" },
    { method: "GET", pattern: "/api/v1/services/health", name: "serviceHealth" },
    { method: "GET", pattern: "/api/v1/services/products", name: "serviceProducts" },
    { method: "POST", pattern: "/api/v1/services/lookup", name: "serviceLookup" },
    { method: "POST", pattern: "/api/v1/services/meters/check", name: "meterCheck" },
    { method: "POST", pattern: "/api/v1/services/orders/:id/poll", name: "servicePoll" },
    { method: "POST", pattern: "/api/v1/services/orders", name: "serviceOrder" },
    { method: "GET", pattern: "/api/v1/services/orders", name: "serviceOrders" },
    { method: "POST", pattern: "/api/v1/webhooks/sandbox", name: "webhook", kind: "webhook" },
  ];
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchPath(route.pattern, pathname);
    if (params) return { name: route.name, params, kind: route.kind };
  }
  return null;
}

function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index] ?? "";
    const actual = pathParts[index] ?? "";
    if (expected.startsWith(":")) params[expected.slice(1)] = decodeURIComponent(actual);
    else if (expected !== actual) return null;
  }
  return params;
}

async function dispatch(name: string, ctx: Ctx, actor: Actor, body: Record<string, unknown>): Promise<unknown> {
  const engine = ctx.app.engine;
  const key = header(ctx.req, "idempotency-key") ?? "";
  if (name === "createSale") {
    return engine.createSale({
      actor,
      terminalId: String(body.terminal_id ?? actor.terminalId ?? ""),
      amount: body.amount,
      currency: body.currency ?? "ZAR",
      paymentMethod: body.payment_method,
      idempotencyKey: key,
    });
  }
  if (name === "authorize") {
    return engine.authorize({
      actor,
      sessionId: ctx.params.id ?? "",
      idempotencyKey: key,
      signal: body.signal,
    });
  }
  if (name === "cancel") return engine.cancelSession({ actor, sessionId: ctx.params.id ?? "" });
  if (name === "resolve") return engine.resolve({ actor, transactionId: ctx.params.id ?? "" });
  if (name === "getTransaction") return engine.getTransaction(actor, ctx.params.id ?? "");
  if (name === "listTransactions") {
    return {
      transactions: engine.listTransactions(actor, {
        terminalId: ctx.url.searchParams.get("terminal_id") ?? undefined,
        status: ctx.url.searchParams.get("status") ?? undefined,
      }),
    };
  }
  if (name === "refund") {
    return engine.refund({
      actor,
      transactionId: String(body.transaction_id ?? ""),
      amount: body.amount,
      reason: body.reason,
      idempotencyKey: key,
    });
  }
  if (name === "listTerminals") return { terminals: engine.listTerminals(actor) };
  if (name === "getTerminal") {
    const terminals = engine.listTerminals(actor);
    const found = terminals.find((item) => item.id === ctx.params.id);
    if (!found) throw new AppError("NOT_FOUND", "Terminal not found.", 404);
    return found;
  }
  if (name === "getConfig") {
    const terminal = engine.listTerminals(actor).find((item) => item.id === ctx.params.id);
    if (!terminal) throw new AppError("NOT_FOUND", "Terminal not found.", 404);
    return terminal.config;
  }
  if (name === "putConfig") {
    return engine.updateConfig({
      actor,
      terminalId: ctx.params.id ?? "",
      patch: body,
    });
  }
  if (name === "heartbeat") {
    return engine.heartbeat({
      actor,
      terminalId: ctx.params.id ?? "",
      online: body.online !== false,
      ackCommand: body.ack_command === true,
    });
  }
  if (name === "command") {
    return engine.command({
      actor,
      terminalId: ctx.params.id ?? "",
      action: String(body.action ?? ""),
    });
  }
  if (name === "registerTerminal") {
    return engine.registerTerminal({
      actor,
      location: body.location,
      deviceModel: body.device_model,
    });
  }
  if (name === "release") {
    return engine.publishRelease({
      actor,
      terminalId: ctx.params.id ?? "",
      version: body.version,
      notes: body.notes,
      failHealth: body.fail_health === true,
      corrupt: body.corrupt === true,
    });
  }
  if (name === "logs") return { logs: engine.listLogs(actor, ctx.params.id ?? "") };
  if (name === "terminalDetail") return engine.getTerminalDetail(actor, ctx.params.id ?? "");
  if (name === "listMerchants") return { merchants: engine.listMerchants(actor) };
  if (name === "getMerchant") return engine.getMerchant(actor, ctx.params.id ?? "");
  if (name === "overview") return engine.overview(actor);
  if (name === "settlements") return engine.settlements(actor);
  if (name === "reconciliation") return engine.reconciliation();
  const services = ctx.app.services;
  if (name === "serviceHealth") return services.providerHealth(actor);
  if (name === "serviceProducts") {
    const type = ctx.url.searchParams.get("type");
    if (type !== "AIRTIME" && type !== "DATA" && type !== "ELECTRICITY" && type !== "VAS" && type !== "SMS") {
      throw new AppError("VALIDATION", "Service type is required.", 400);
    }
    return { products: services.products(actor, type) };
  }
  if (name === "serviceLookup") return services.lookup(actor, body.msisdn);
  if (name === "meterCheck") return services.checkMeter(actor, body.meter_number);
  if (name === "serviceOrder") {
    const type = body.service_type;
    if (type !== "AIRTIME" && type !== "DATA" && type !== "ELECTRICITY" && type !== "VAS" && type !== "SMS") {
      throw new AppError("VALIDATION", "Service type is required.", 400);
    }
    return services.create(
      actor,
      {
        serviceType: type,
        amount: typeof body.amount === "number" ? body.amount : undefined,
        msisdn: typeof body.msisdn === "string" ? body.msisdn : undefined,
        meterNumber: typeof body.meter_number === "string" ? body.meter_number : undefined,
        productId: typeof body.product_id === "string" ? body.product_id : undefined,
        message: typeof body.message === "string" ? body.message : undefined,
        simulation: body.simulation,
      },
      key,
    );
  }
  if (name === "servicePoll") return services.poll(actor, ctx.params.id ?? "");
  if (name === "serviceOrders") return { orders: services.list(actor) };
  throw new AppError("NOT_FOUND", "Not found.", 404);
}

function authenticate(req: IncomingMessage, app: App): Actor {
  const value = header(req, "authorization");
  const token = value?.startsWith("Bearer ") ? value.slice(7) : "";
  const actor = app.actors.get(token) ?? app.engine.store.deviceTokens.get(token);
  if (!actor) throw new AppError("UNAUTHORIZED", "A valid bearer token is required.", 401);
  return actor;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new AppError("VALIDATION", "Request body is too large.", 413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRaw(req);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AppError("VALIDATION", "JSON body must be an object.", 400);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (isAppError(error)) throw error;
    throw new AppError("VALIDATION", "Request body must be JSON.", 400);
  }
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const requested = pathname === "/" ? "/index.html" : pathname === "/admin" ? "/admin.html" : pathname;
  const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!filePath.startsWith(PUBLIC_DIR)) throw new AppError("FORBIDDEN", "Forbidden.", 403);
  try {
    const body = await readFile(filePath);
    const ext = path.extname(filePath);
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
    };
    res.writeHead(200, { "content-type": types[ext] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    throw new AppError("NOT_FOUND", "Not found.", 404);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) return;
  if (isAppError(error)) {
    send(res, error.status, { error: { code: error.code, message: error.message } });
    return;
  }
  send(res, 500, { error: { code: "INTERNAL", message: "Unexpected server error." } });
}
