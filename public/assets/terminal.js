const screen = document.querySelector("#screen");
const toast = document.querySelector("#toast");
const net = document.querySelector("#net");
const clock = document.querySelector("#clock");

const state = {
  token: "",
  terminalId: "RF-TERM-000001",
  online: true,
  amount: 0,
  sale: null,
  payKey: "",
  overview: null,
  view: "home",
  config: {
    cash_enabled: true,
    card_enabled: true,
    contactless_enabled: true,
    qr_enabled: true,
    receipt_enabled: true,
    auto_update: true,
  },
  terminal: null,
  serviceSignal: "success",
  provider: "simulator",
  recent: [],
};

function money(cents) {
  const abs = Math.abs(cents);
  const rands = Math.floor(abs / 100);
  const rem = String(abs % 100).padStart(2, "0");
  const grouped = rands.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${cents < 0 ? "-" : ""}R ${grouped}.${rem}`;
}

function key() {
  return `${state.terminalId}-${crypto.randomUUID()}`;
}

async function api(path, options = {}) {
  const headers = { authorization: `Bearer ${state.token}`, ...(options.headers ?? {}) };
  if (options.body) headers["content-type"] = "application/json";
  const response = await fetch(path, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message ?? "Request failed");
  return payload;
}

let watchTimer = null;

function stopWatch() {
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
}

function pillClass(status) {
  if (status === "COMPLETED") return "ok";
  if (status === "PENDING" || status === "SUBMITTED" || status === "TIMEOUT") return "warn";
  return "bad";
}

function slipLabel(order) {
  if (order.status === "PENDING" || order.status === "SUBMITTED") return "PENDING";
  if (order.status !== "COMPLETED") return order.status;
  if (order.service_type === "AIRTIME" || order.service_type === "DATA") return "SENT";
  if (order.service_type === "SMS") return "DELIVERED";
  if (order.voucher) return "VOUCHER";
  return "COMPLETED";
}

function slipNote(order) {
  const direct = order.service_type === "AIRTIME" || order.service_type === "DATA" || order.service_type === "SMS";
  if (order.status === "PENDING" || order.status === "SUBMITTED" || order.status === "TIMEOUT") {
    return "Waiting for SIMcloud. This screen updates by itself.";
  }
  if (order.status === "COMPLETED" && direct) {
    return `Loaded on ${order.msisdn}. No token. The network puts it on the number.`;
  }
  if (order.status === "COMPLETED" && order.voucher) {
    return "Give this slip to the customer. They enter the token.";
  }
  return "";
}

function setError(message) {
  toast.textContent = message ?? "";
}

function shortTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" });
}

function statusClass(status) {
  if (status === "COMPLETED" || status === "SENT" || status === "DELIVERED" || status === "VOUCHER") return "ok";
  if (status === "DECLINED" || status === "FAILED" || status === "CANCELLED") return "bad";
  return "warn";
}

function renderHome() {
  stopWatch();
  if (!guardUnlocked()) return;
  state.view = "home";
  markNav("home");
  const overview = state.overview;
  const job = state.terminal?.update_job;
  const updating = job && job.status !== "COMPLETED" && job.status !== "ROLLED_BACK";
  const place = state.terminal?.location ? `${state.terminal.location}` : state.terminalId;
  const paid = overview ? overview.successful : 0;
  const latest = state.recent.map((row) => `
    <button class="ghost feed-row" type="button" data-kind="${row.kind}" data-id="${row.id}">
      <span><b>${row.title}</b> <span class="muted">${row.detail}</span></span>
      <span class="${statusClass(row.status)}">${shortTime(row.at)} ${row.status}</span>
    </button>`).join("");
  screen.innerHTML = `
    ${updating ? `<div class="banner" id="update-banner">Software ${job.version}: ${job.status.replaceAll("_", " ")}</div>` : ""}
    <section class="glass hero">
      <div class="hero-top">
        <p class="eyebrow">Today</p>
        <p class="eyebrow">${escapeHtml(place)}</p>
      </div>
      <div class="amount shift-total">${overview ? overview.volume_display : "R 0.00"}</div>
      <div class="chips">
        <span class="chip">${paid} paid</span>
        ${overview?.failed ? `<span class="chip bad">${overview.failed} declined</span>` : ""}
      </div>
    </section>
    <section class="glass sheet">
      <p class="eyebrow">Quick charge</p>
      <div class="quick" id="quick">
        <button class="ghost" type="button" data-cents="2000">R 20</button>
        <button class="ghost" type="button" data-cents="5000">R 50</button>
        <button class="ghost" type="button" data-cents="10000">R 100</button>
        <button class="ghost" type="button" data-cents="25000">R 250</button>
      </div>
      <button class="primary" id="new-sale" type="button">Other amount</button>
    </section>
    <section class="glass sheet">
      <h3>Latest</h3>
      <div class="feed">${latest || `<p class="muted">No sales yet. A quick amount starts the next one.</p>`}</div>
    </section>`;
  for (const button of screen.querySelectorAll("#quick button")) {
    button.onclick = () => quickSale(Number(button.dataset.cents));
  }
  screen.querySelector("#new-sale").onclick = () => {
    if (!guardUnlocked()) return;
    state.amount = 0;
    state.sale = null;
    renderAmount();
  };
  bindFeed(screen);
}

function quickSale(cents) {
  if (!guardUnlocked()) return;
  state.amount = cents;
  state.sale = null;
  setError("");
  renderMethods();
}

function bindFeed(root) {
  for (const button of root.querySelectorAll(".feed-row")) {
    button.onclick = () => openActivity(button.dataset.kind, button.dataset.id);
  }
}

async function openActivity(kind, id) {
  try {
    if (kind === "service") {
      const orders = await api("/api/v1/services/orders");
      const order = orders.orders.find((item) => item.id === id);
      if (order) renderServiceResult(order);
      return;
    }
    renderResult(await api(`/api/v1/transactions/${id}`));
  } catch (error) {
    setError(error.message);
  }
}

function renderAmount() {
  if (!guardUnlocked()) return;
  state.view = "amount";
  markNav("home");
  screen.innerHTML = `
    <div class="muted">Amount</div>
    <div class="amount">${money(state.amount)}</div>
    <div class="quick">
      <button class="ghost" id="q20" type="button">R 20</button>
      <button class="ghost" id="q50" type="button">R 50</button>
      <button class="ghost" id="q100" type="button">R 100</button>
      <button class="ghost" id="q250" type="button">R 250</button>
    </div>
    <div class="keys" id="keys"></div>
    <div class="methods">
      <button class="ghost" id="back-home" type="button">Home</button>
      <button class="primary" id="continue" type="button">Charge</button>
    </div>`;
  const keys = screen.querySelector("#keys");
  for (const label of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "⌫"]) {
    const button = document.createElement("button");
    button.className = "key";
    button.type = "button";
    button.textContent = label;
    button.onclick = () => {
      if (label === "C") state.amount = 0;
      else if (label === "⌫") state.amount = Math.floor(state.amount / 10);
      else state.amount = Math.min(state.amount * 10 + Number(label), 100_000_000);
      renderAmount();
    };
    keys.append(button);
  }
  for (const [id, cents] of [["q20", 2000], ["q50", 5000], ["q100", 10000], ["q250", 25000]]) {
    screen.querySelector(`#${id}`).onclick = () => {
      state.amount = cents;
      renderAmount();
    };
  }
  screen.querySelector("#back-home").onclick = () => renderHome();
  screen.querySelector("#continue").onclick = () => {
    if (state.amount < 1) {
      setError("Enter an amount first.");
      return;
    }
    setError("");
    renderMethods();
  };
}

function methodAllowed(method) {
  if (method === "cash") return state.config.cash_enabled;
  if (!state.online) return false;
  if (method === "card") return state.config.card_enabled;
  if (method === "tap") return state.config.contactless_enabled;
  if (method === "qr") return state.config.qr_enabled;
  return false;
}

function renderMethods() {
  if (!guardUnlocked()) return;
  state.view = "methods";
  state.methodSignature = `${JSON.stringify(state.config)}:${state.terminal?.status}:${state.online}`;
  markNav("home");
  const tile = (method, label, hint) => `<button class="pay-tile" data-method="${method}" type="button" ${methodAllowed(method) ? "" : "disabled"}><b>${label}</b><span>${hint}</span></button>`;
  const cardBlocked = !state.online;
  screen.innerHTML = `
    <div class="muted">Charge</div>
    <div class="amount small">${money(state.amount)}</div>
    <div class="pay-grid">
      ${tile("cash", "Cash", "Counted now")}
      ${tile("card", "Card", cardBlocked ? "Needs network" : "Reader")}
      ${tile("tap", "Tap", cardBlocked ? "Needs network" : "Contactless")}
      ${tile("qr", "QR", cardBlocked ? "Needs network" : "Customer scans")}
    </div>
    ${cardBlocked ? `<p class="warn">Network is off. Cash still works.</p>` : ""}
    <button class="ghost" id="back-amount" type="button">Change amount</button>`;
  screen.querySelector("#back-amount").onclick = () => renderAmount();
  for (const item of screen.querySelectorAll("[data-method]")) {
    item.onclick = () => {
      if (!methodAllowed(item.dataset.method)) return;
      startSale(item.dataset.method);
    };
  }
}

async function startSale(method) {
  setError("");
  const saleKey = key();
  try {
    const sale = await api("/api/v1/sales", {
      method: "POST",
      headers: { "idempotency-key": saleKey },
      body: {
        terminal_id: state.terminalId,
        amount: state.amount,
        currency: "ZAR",
        payment_method: method,
      },
    });
    state.sale = sale;
    state.payKey = key();
    if (method === "cash") renderResult(sale);
    else renderWaiting(sale);
  } catch (error) {
    setError(error.message);
  }
}

function renderWaiting(sale) {
  state.view = "waiting";
  markNav("home");
  const method = sale.payment_method;
  const qr = method === "qr";
  const tap = method === "tap";
  const headline = qr ? "Customer scans the code" : tap ? "Hold the card here" : "Present the card now";
  const note = qr
    ? "PAY draws this demo code for the sale. Scanning it does not charge a bank. A real QR provider replaces this picture later. Approve records the practice payment."
    : "Tap the card to approve this practice payment. The card number and PIN are never typed here. A certified reader will take the real card later.";
  const qrCells = qr ? demoQrCells(`${sale.id}:${sale.amount_display}`) : [];
  screen.innerHTML = `
    <p class="eyebrow">${qr ? "QR" : tap ? "Tap" : "Card"}</p>
    <div class="amount small">${sale.amount_display}</div>
    ${qr ? `<div class="qr-card" aria-hidden="true"><div class="qr-grid">${qrCells.map((on) => `<i class="${on ? "on" : "off"}"></i>`).join("")}</div></div><p class="muted">${sale.id}</p>` : `
      <button class="demo-card" id="sig-approve" type="button">
        <span class="demo-chip"></span>
        <span class="demo-brand">PAY</span>
        <span class="demo-pan">Tap the card</span>
        <span class="demo-hold">${tap ? "Contactless" : "Insert or tap"}</span>
      </button>`}
    <p class="wait-copy">${headline}</p>
    <p class="muted reader-note">${note}</p>
    ${qr ? `<button class="primary" id="sig-approve" type="button">Payment scanned</button>` : ""}
    <button class="ghost" id="sig-decline" type="button">Decline</button>
    <details class="more">
      <summary>Other reader results</summary>
      <div class="methods">
        <button class="ghost" id="sig-timeout" type="button">Timeout</button>
        <button class="ghost" id="sig-network" type="button">Network error</button>
        <button class="ghost" id="sig-provider" type="button">Provider failure</button>
        <button class="ghost" id="sig-cancel" type="button">Cancel card</button>
      </div>
    </details>
    <button class="ghost" id="cancel" type="button">Cancel sale</button>`;
  screen.querySelector("#sig-approve").onclick = () => authorize("approve");
  screen.querySelector("#sig-decline").onclick = () => authorize("decline");
  screen.querySelector("#sig-timeout").onclick = () => authorize("timeout");
  screen.querySelector("#sig-network").onclick = () => authorize("network_error");
  screen.querySelector("#sig-provider").onclick = () => authorize("provider_failure");
  screen.querySelector("#sig-cancel").onclick = () => authorize("cancel");
  screen.querySelector("#cancel").onclick = async () => {
    try {
      const cancelled = await api(`/api/v1/payment-sessions/${sale.session_id}/cancel`, { method: "POST" });
      state.sale = cancelled;
      renderResult(cancelled);
    } catch (error) {
      setError(error.message);
    }
  };
}

function demoQrCells(text) {
  const size = 25;
  const cells = Array.from({ length: size * size }, () => false);
  const set = (x, y, value) => {
    if (x >= 0 && y >= 0 && x < size && y < size) cells[y * size + x] = value;
  };
  const finder = (ox, oy) => {
    for (let y = 0; y < 7; y += 1) {
      for (let x = 0; x < 7; x += 1) {
        const edge = x === 0 || y === 0 || x === 6 || y === 6;
        const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        set(ox + x, oy + y, edge || core);
      }
    }
  };
  finder(0, 0);
  finder(size - 7, 0);
  finder(0, size - 7);
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  for (let index = 0; index < cells.length; index += 1) {
    const x = index % size;
    const y = Math.floor(index / size);
    if ((x < 8 && y < 8) || (x > size - 9 && y < 8) || (x < 8 && y > size - 9)) continue;
    hash = Math.imul(hash ^ (index + 1), 16777619);
    cells[index] = (hash >>> 24) % 3 !== 0;
  }
  return cells;
}

function renderResult(sale) {
  state.view = "result";
  markNav("home");
  const unknown = sale.status === "UNKNOWN";
  const approved = sale.status === "COMPLETED";
  const klass = unknown ? "warn" : approved ? "" : "bad";
  const title = approved ? "PAYMENT APPROVED" : unknown ? "STATUS UNKNOWN" : sale.status.replaceAll("_", " ");
  screen.innerHTML = `
    <div class="status-pill ${klass}">${title}</div>
    <div class="amount small">${sale.amount_display}</div>
    <p>${sale.id}</p>
    <p class="muted">${sale.merchant_name} · ${sale.terminal_id}</p>
    ${unknown ? `<p class="warn">The provider may already have taken this payment. Do not start a new sale.</p><button class="primary" id="check-status" type="button">Check status</button>` : ""}
    ${sale.receipt ? `<div class="receipt">${escapeHtml(sale.receipt)}</div>` : ""}
    <button class="primary" id="done" type="button">New sale</button>`;
  const check = screen.querySelector("#check-status");
  if (check) {
    check.onclick = async () => {
      try {
        const updated = await api(`/api/v1/transactions/${sale.id}/resolve`, { method: "POST" });
        state.sale = updated;
        renderResult(updated);
        await refresh();
      } catch (error) {
        setError(error.message);
      }
    };
  }
  screen.querySelector("#done").onclick = async () => {
    state.sale = null;
    await refresh();
    renderHome();
  };
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function authorize(signal) {
  if (!state.sale?.session_id) return;
  setError("");
  try {
    const sale = await api(`/api/v1/payment-sessions/${state.sale.session_id}/authorize`, {
      method: "POST",
      headers: { "idempotency-key": state.payKey },
      body: { signal },
    });
    state.sale = sale;
    renderResult(sale);
    await refresh();
  } catch (error) {
    setError(error.message);
  }
}

async function refresh() {
  const [overview, sales, services] = await Promise.all([
    api("/api/v1/reports/overview"),
    api("/api/v1/transactions"),
    api("/api/v1/services/orders"),
  ]);
  state.overview = overview;
  const rows = [
    ...sales.transactions.map((tx) => ({
      kind: "sale",
      id: tx.id,
      title: tx.amount_display,
      detail: tx.payment_method,
      status: tx.status,
      at: tx.created_at,
    })),
    ...services.orders.map((order) => ({
      kind: "service",
      id: order.id,
      title: order.amount_display,
      detail: order.service_type,
      status: slipLabel(order),
      at: order.created_at,
    })),
  ];
  rows.sort((a, b) => (a.at < b.at ? 1 : -1));
  state.recent = rows.slice(0, 5);
}

function markNav(name) {
  for (const button of document.querySelectorAll("#nav button")) {
    if (button.dataset.nav === name) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
}

function guardUnlocked() {
  const status = state.terminal?.status;
  if (status === "LOCKED" || status === "DISABLED") {
    renderLock();
    return false;
  }
  return true;
}

function renderLock() {
  stopWatch();
  state.view = "lock";
  markNav("home");
  const status = state.terminal?.status ?? "LOCKED";
  screen.innerHTML = `
    <div class="status-pill bad">${status}</div>
    <p class="wait-copy">This terminal cannot take payments.</p>
    <p class="muted">${state.terminalId}</p>`;
}

async function renderHistory() {
  stopWatch();
  if (!guardUnlocked()) return;
  state.view = "history";
  markNav("history");
  screen.innerHTML = `<p class="muted">Loading history…</p>`;
  const [payload, services] = await Promise.all([api("/api/v1/transactions"), api("/api/v1/services/orders")]);
  const pending = services.orders.filter((order) => order.status === "PENDING" || order.status === "SUBMITTED" || order.status === "TIMEOUT");
  if (pending.length > 0) {
    await Promise.all(pending.map((order) => api(`/api/v1/services/orders/${order.id}/poll`, { method: "POST", body: {} })));
  }
  const fresh = pending.length > 0 ? await api("/api/v1/services/orders") : services;
  const activity = [
    ...payload.transactions.map((tx) => ({
      kind: "sale",
      id: tx.id,
      title: tx.amount_display,
      detail: tx.payment_method,
      status: tx.status,
      at: tx.created_at,
    })),
    ...fresh.orders.map((order) => ({
      kind: "service",
      id: order.id,
      title: order.amount_display,
      detail: order.service_type,
      status: slipLabel(order),
      at: order.created_at,
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));
  screen.innerHTML = `
    <h2>History</h2>
    ${activity.length === 0 ? `<p class="muted">No transactions yet.</p>` : `<div class="feed">${activity.map((row) => `
      <button class="ghost feed-row" type="button" data-kind="${row.kind}" data-id="${row.id}">
        <span><b>${row.title}</b> <span class="muted">${row.detail}</span></span>
        <span class="${statusClass(row.status)}">${shortTime(row.at)} ${row.status}</span>
      </button>`).join("")}</div>`}`;
  bindFeed(screen);
}

function renderServices() {
  stopWatch();
  if (!guardUnlocked()) return;
  state.view = "services";
  markNav("services");
  const live = state.provider === "simcloud";
  screen.innerHTML = `
    <h2>Services</h2>
    <p class="muted">${live ? "Live on the number. Electricity and shop vouchers print a token on the slip." : "Practice catalogue. Electricity and shop vouchers print a token on the slip."}</p>
    <div class="pay-grid">
      <button class="pay-tile" type="button" id="svc-airtime"><b>Airtime</b><span>Any amount, R2 to R999</span></button>
      <button class="pay-tile" type="button" id="svc-data"><b>Data</b><span>Bundles from the catalogue</span></button>
      <button class="pay-tile" type="button" id="svc-elec"><b>Electricity</b><span>Meter token on the slip</span></button>
      <button class="pay-tile" type="button" id="svc-vas"><b>Vouchers</b><span>Shop codes on the slip</span></button>
      <button class="pay-tile" type="button" id="svc-sms"><b>SMS</b><span>A message to a number</span></button>
    </div>`;
  document.querySelector("#svc-airtime").onclick = () => renderAirtime();
  document.querySelector("#svc-data").onclick = () => renderCatalogue("DATA").catch((error) => setError(error.message));
  document.querySelector("#svc-elec").onclick = () => renderElectricity();
  document.querySelector("#svc-vas").onclick = () => renderCatalogue("VAS").catch((error) => setError(error.message));
  document.querySelector("#svc-sms").onclick = () => renderSms();
}

function renderServiceResult(order) {
  stopWatch();
  state.view = "service-result";
  state.watchedOrderId = order.id;
  markNav("services");
  const note = slipNote(order);
  const pin = order.voucher ? `<p class="pin">${order.voucher}</p>` : "";
  const units = order.units ? `<p>${order.units}</p>` : "";
  const who = order.msisdn ? `<p>${order.msisdn}</p>` : order.meter_number ? `<p>Meter ${order.meter_number}</p>` : "";
  screen.innerHTML = `
    <div class="slip">
      <div class="status-pill ${pillClass(order.status)}">${slipLabel(order)}</div>
      <p>${order.product_name ?? order.service_type}${order.network ? ` · ${order.network}` : ""}</p>
      ${who}
      <p class="amount">${order.amount_display}</p>
      ${pin}${units}
      <p>${note}</p>
      <p class="muted">${order.provider_reference ?? ""}</p>
      <p class="muted">${order.id}</p>
      ${order.failure_reason ? `<p class="bad">${order.failure_reason}</p>` : ""}
    </div>
    <button class="ghost" type="button" id="back-services">Services</button>`;
  document.querySelector("#back-services").onclick = () => renderServices();
  if (order.status === "PENDING" || order.status === "SUBMITTED" || order.status === "TIMEOUT") {
    watchTimer = setInterval(() => {
      if (state.view !== "service-result" || state.watchedOrderId !== order.id) {
        stopWatch();
        return;
      }
      api(`/api/v1/services/orders/${order.id}/poll`, { method: "POST", body: {} })
        .then((updated) => {
          if (updated.status !== order.status || updated.voucher !== order.voucher || updated.provider_reference !== order.provider_reference) {
            renderServiceResult(updated);
          }
        })
        .catch((error) => setError(error.message));
    }, 3000);
  }
}

async function placeService(body) {
  const order = await api("/api/v1/services/orders", {
    method: "POST",
    headers: { "idempotency-key": key() },
    body: { ...body, simulation: state.serviceSignal },
  });
  renderServiceResult(order);
}

function renderAirtime() {
  stopWatch();
  state.view = "airtime";
  screen.innerHTML = `
    <h2>Airtime</h2>
    <p class="muted">Goes straight onto the number. Any amount from R2 to R999. No voucher.</p>
    <input id="msisdn" placeholder="Mobile number" inputmode="numeric">
    <input id="airtime-rand" placeholder="Amount in rand" inputmode="decimal">
    <button class="primary" type="button" id="send-airtime">Send airtime</button>
    <div class="methods">
      <button class="choice" type="button" data-amount="1000">R10</button>
      <button class="choice" type="button" data-amount="2000">R20</button>
      <button class="choice" type="button" data-amount="5000">R50</button>
    </div>
    <button class="ghost" type="button" id="back-services">Back</button>`;
  document.querySelector("#back-services").onclick = () => renderServices();
  const send = (cents) => {
    placeService({
      service_type: "AIRTIME",
      msisdn: document.querySelector("#msisdn").value,
      amount: cents,
    }).catch((error) => setError(error.message));
  };
  document.querySelector("#send-airtime").onclick = () => {
    const rands = Number(document.querySelector("#airtime-rand").value);
    if (!Number.isFinite(rands) || rands < 2 || rands > 999) {
      setError("Airtime must be between R2 and R999.");
      return;
    }
    send(Math.round(rands * 100));
  };
  for (const button of screen.querySelectorAll("[data-amount]")) {
    button.onclick = () => send(Number(button.dataset.amount));
  }
}

function bundleLabel(description) {
  const cleaned = String(description).replace(/-R\d+(?:\.\d+)?(?:\s*\([^)]*\))?$/i, "");
  return cleaned || description;
}

function groupRank(name) {
  const value = name.toLowerCase();
  if (value.includes("daily") || value.includes("same day")) return 0;
  if (value.includes("weekly") || value.includes("weekend")) return 1;
  if (value.includes("monthly") || value.includes("30-day") || value.includes("30 day")) return 2;
  if (value.includes("365")) return 3;
  if (value.includes("night")) return 4;
  if (value.includes("whatsapp")) return 5;
  return 6;
}

function networkLabel(code) {
  if (code === "CELLC") return "Cell C";
  if (code === "VODACOM") return "Vodacom";
  if (code === "TELKOM") return "Telkom";
  return code || "Network";
}

async function renderCatalogue(type) {
  stopWatch();
  state.view = type.toLowerCase();
  const title = type === "DATA" ? "Data" : "Vouchers";
  screen.innerHTML = `<h2>${title}</h2><p class="muted">Loading from SIMcloud…</p>`;
  let products = [];
  try {
    const payload = await api(`/api/v1/services/products?type=${type}`);
    products = Array.isArray(payload.products) ? payload.products : [];
  } catch (error) {
    setError(error.message);
    screen.innerHTML = `
      <h2>${title}</h2>
      <p class="bad">${escapeHtml(error.message)}</p>
      <button class="ghost" type="button" id="back-services">Back</button>`;
    document.querySelector("#back-services").onclick = () => renderServices();
    return;
  }
  if (type === "DATA") renderDataNetworks(products);
  else renderVoucherShops(products);
}

function renderDataNetworks(products) {
  const networks = ["MTN", "VODACOM", "CELLC", "TELKOM"].filter((code) => products.some((product) => product.network === code));
  screen.innerHTML = `
    <h2>Data</h2>
    <p class="muted">Choose the network. Bundles are grouped the way SIMcloud names them: daily, weekly, monthly, and the rest.</p>
    <div class="pay-grid">
      ${networks.map((code) => `<button class="pay-tile" type="button" data-network="${code}"><b>${networkLabel(code)}</b><span>${products.filter((product) => product.network === code).length} bundles</span></button>`).join("")}
    </div>
    <button class="ghost" type="button" id="back-services">Back</button>`;
  document.querySelector("#back-services").onclick = () => renderServices();
  for (const button of screen.querySelectorAll("[data-network]")) {
    button.onclick = () => renderDataGroups(products, button.dataset.network);
  }
}

function renderDataGroups(products, network) {
  const rows = products.filter((product) => product.network === network);
  const groups = [...new Set(rows.map((product) => product.group || "Bundles"))].sort((a, b) => groupRank(a) - groupRank(b) || a.localeCompare(b));
  screen.innerHTML = `
    <h2>${networkLabel(network)}</h2>
    <p class="muted">The bundle loads onto the number. No voucher.</p>
    <input id="msisdn" placeholder="Mobile number" inputmode="numeric">
    ${groups.map((group) => `
      <section class="glass sheet">
        <h3>${escapeHtml(group)}</h3>
        <div class="catalogue">
          ${rows.filter((product) => (product.group || "Bundles") === group).map((product) => `
            <button class="bundle" type="button" data-product="${product.id}">
              <span>${escapeHtml(bundleLabel(product.name))}</span>
              <b>${product.amount_display}</b>
            </button>`).join("")}
        </div>
      </section>`).join("")}
    <button class="ghost" type="button" id="back-networks">Networks</button>`;
  document.querySelector("#back-networks").onclick = () => renderDataNetworks(products);
  bindBundleBuy(screen, "DATA");
}

function renderVoucherShops(products) {
  const shops = [...new Set(products.map((product) => product.group || product.name))].sort((a, b) => a.localeCompare(b));
  screen.innerHTML = `
    <h2>Vouchers</h2>
    <p class="muted">Choose the shop. The code appears on the slip when SIMcloud finishes.</p>
    <input id="shop-filter" placeholder="Search shops">
    <div class="pay-grid" id="shops"></div>
    <button class="ghost" type="button" id="back-services">Back</button>`;
  document.querySelector("#back-services").onclick = () => renderServices();
  const paint = (query) => {
    const needle = query.trim().toLowerCase();
    const matched = shops.filter((shop) => shop.toLowerCase().includes(needle)).slice(0, 24);
    document.querySelector("#shops").innerHTML = matched.map((shop) => `
      <button class="pay-tile" type="button" data-shop="${escapeHtml(shop)}"><b>${escapeHtml(shop)}</b><span>${products.filter((product) => (product.group || product.name) === shop).length} amounts</span></button>`).join("");
    for (const button of document.querySelectorAll("[data-shop]")) {
      button.onclick = () => renderVoucherAmounts(products, button.dataset.shop);
    }
  };
  document.querySelector("#shop-filter").oninput = (event) => paint(event.target.value);
  paint("");
}

function renderVoucherAmounts(products, shop) {
  const rows = products.filter((product) => (product.group || product.name) === shop);
  screen.innerHTML = `
    <h2>${escapeHtml(shop)}</h2>
    <p class="muted">The voucher code appears on the slip.</p>
    <input id="msisdn" placeholder="Mobile number" inputmode="numeric">
    <div class="catalogue">
      ${rows.map((product) => `
        <button class="bundle" type="button" data-product="${product.id}">
          <span>${escapeHtml(shop)}</span>
          <b>${product.amount_display}</b>
        </button>`).join("")}
    </div>
    <button class="ghost" type="button" id="back-shops">Shops</button>`;
  document.querySelector("#back-shops").onclick = () => renderVoucherShops(products);
  bindBundleBuy(screen, "VAS");
}

function bindBundleBuy(root, type) {
  for (const button of root.querySelectorAll("[data-product]")) {
    button.onclick = () => {
      const msisdn = document.querySelector("#msisdn").value;
      if (msisdn.trim().length < 10) {
        setError("Enter the mobile number first.");
        return;
      }
      setError("");
      placeService({
        service_type: type,
        product_id: button.dataset.product,
        msisdn,
      }).catch((error) => setError(error.message));
    };
  }
}

function renderElectricity() {
  stopWatch();
  state.view = "electricity";
  screen.innerHTML = `
    <h2>Electricity</h2>
    <p class="muted">R50 to R1000. The token shows on the slip when SIMcloud finishes, and the SMS number gets the same PIN.</p>
    <input id="meter" placeholder="Meter number" inputmode="numeric">
    <input id="msisdn" placeholder="SMS number for the voucher" inputmode="numeric">
    <input id="elec-rand" placeholder="Amount in rand" inputmode="decimal" value="150">
    <button class="choice" type="button" id="check-meter">Check meter</button>
    <p id="meter-result" class="muted"></p>
    <button class="primary" type="button" id="buy-elec">Buy electricity</button>
    <button class="ghost" type="button" id="back-services">Back</button>`;
  document.querySelector("#back-services").onclick = () => renderServices();
  document.querySelector("#check-meter").onclick = async () => {
    setError("");
    const resultBox = document.querySelector("#meter-result");
    resultBox.textContent = "Checking the meter with SIMcloud…";
    try {
      const result = await api("/api/v1/services/meters/check", {
        method: "POST",
        body: { meter_number: document.querySelector("#meter").value },
      });
      resultBox.textContent = result.valid ? `Meter validated${result.holder ? ` · ${result.holder}` : ""}` : "Meter not found";
      resultBox.className = result.valid ? "ok" : "bad";
    } catch (error) {
      resultBox.textContent = error.message;
      resultBox.className = "bad";
      setError(error.message);
    }
  };
  document.querySelector("#buy-elec").onclick = () => {
    const rands = Number(document.querySelector("#elec-rand").value);
    if (!Number.isFinite(rands) || rands < 50 || rands > 1000) {
      setError("Electricity must be between R50 and R1000.");
      return;
    }
    setError("");
    placeService({
      service_type: "ELECTRICITY",
      meter_number: document.querySelector("#meter").value,
      msisdn: document.querySelector("#msisdn").value,
      amount: Math.round(rands * 100),
    }).catch((error) => setError(error.message));
  };
}

function renderSms() {
  stopWatch();
  state.view = "sms";
  screen.innerHTML = `
    <h2>SMS</h2>
    <input id="msisdn" placeholder="Mobile number" inputmode="numeric">
    <input id="sms-body" placeholder="Message">
    <button class="primary" type="button" id="send-sms">Send · R1.00</button>
    <button class="ghost" type="button" id="back-services">Back</button>`;
  document.querySelector("#back-services").onclick = () => renderServices();
  document.querySelector("#send-sms").onclick = () => {
    const msisdn = document.querySelector("#msisdn").value;
    const message = document.querySelector("#sms-body").value;
    if (msisdn.trim().length < 10) {
      setError("Enter the mobile number first.");
      return;
    }
    if (message.trim().length < 1) {
      setError("Enter an SMS message.");
      return;
    }
    setError("");
    placeService({
      service_type: "SMS",
      msisdn,
      message,
      amount: 100,
    }).catch((error) => setError(error.message));
  };
}

async function renderSettings() {
  stopWatch();
  state.view = "settings";
  markNav("settings");
  const terminal = await api(`/api/v1/terminals/${state.terminalId}`);
  const logs = await api(`/api/v1/terminals/${state.terminalId}/logs`);
  state.terminal = terminal;
  state.config = terminal.config;
  const job = terminal.update_job;
  const configRows = [
    ["Cash", terminal.config.cash_enabled],
    ["Card", terminal.config.card_enabled],
    ["Tap", terminal.config.contactless_enabled],
    ["QR", terminal.config.qr_enabled],
    ["Receipt", terminal.config.receipt_enabled],
    ["Auto-update", terminal.config.auto_update],
  ];
  screen.innerHTML = `
    <h2>Settings</h2>
    <p>${terminal.location}</p>
    <p class="muted">${terminal.status} · v${terminal.software_version}</p>
    ${job ? `<div class="banner">Update ${job.version}: ${job.status.replaceAll("_", " ")}</div>` : ""}
    ${configRows.map(([label, enabled]) => `<div class="row"><span>${label}</span><span class="${enabled ? "ok" : "bad"}">${enabled ? "On" : "Off"}</span></div>`).join("")}
    <h3>Logs</h3>
    ${logs.logs.length === 0 ? `<p class="muted">No logs yet.</p>` : logs.logs.slice(-8).map((entry) => `<p class="log ${entry.level === "warn" ? "warn" : "muted"}">${entry.timestamp.slice(11, 19)} ${escapeHtml(entry.message)}</p>`).join("")}
    <h3>Connection</h3>
    <p class="muted">Card payments stop when the network is off. Cash still works.</p>
    <button class="ghost" id="toggle-net" type="button">${state.online ? "Go offline" : "Go online"}</button>
    <h3>Pair this phone</h3>
    <form id="pair-form">
      <input id="pair-code" placeholder="Pairing code" autocomplete="one-time-code" inputmode="text">
      <button class="ghost" type="submit">Pair</button>
    </form>`;
  state.settingsSignature = `${JSON.stringify(terminal.config)}:${terminal.status}:${terminal.software_version}:${job?.status ?? ""}:${state.online}`;
  document.querySelector("#software-version").textContent = `v${terminal.software_version}`;
  screen.querySelector("#pair-form").onsubmit = async (event) => {
    event.preventDefault();
    const code = screen.querySelector("#pair-code").value.trim();
    const response = await fetch("/api/v1/terminals/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error?.message ?? "Pairing failed");
      return;
    }
    sessionStorage.setItem("redface-device-token", payload.device_token);
    sessionStorage.setItem("redface-terminal-id", payload.terminal_id);
    state.token = payload.device_token;
    state.terminalId = payload.terminal_id;
    document.querySelector("#terminal-id").textContent = state.terminalId;
    setError("");
    const beat = await api(`/api/v1/terminals/${state.terminalId}/heartbeat`, {
      method: "POST",
      body: { online: true },
    });
    await applyBeat(beat);
    await refresh();
    renderHome();
  };
  screen.querySelector("#toggle-net").onclick = async () => {
    state.online = !state.online;
    const beat = await api(`/api/v1/terminals/${state.terminalId}/heartbeat`, {
      method: "POST",
      body: { online: state.online },
    });
    await applyBeat(beat);
  };
}

async function applyBeat(beat) {
  state.terminal = beat;
  state.config = beat.config;
  document.querySelector("#software-version").textContent = `v${beat.software_version}`;
  net.textContent = state.online ? beat.status : "OFFLINE";
  net.dataset.state = state.online ? "on" : "off";
  if (beat.pending_command?.status === "queued" && beat.pending_command.action === "restart") {
    await api(`/api/v1/terminals/${state.terminalId}/heartbeat`, {
      method: "POST",
      body: { online: state.online, ack_command: true },
    });
  }
  if (beat.status === "LOCKED" || beat.status === "DISABLED") {
    renderLock();
    return;
  }
  if (state.view === "lock") {
    await refresh();
    renderHome();
    return;
  }
  const banner = document.querySelector("#update-banner");
  const job = beat.update_job;
  const updating = job && job.status !== "COMPLETED" && job.status !== "ROLLED_BACK";
  if (banner) banner.textContent = updating ? `Software ${job.version}: ${job.status.replaceAll("_", " ")}` : "";
  const signature = `${JSON.stringify(beat.config)}:${beat.status}:${state.online}`;
  const settingsSignature = `${signature}:${beat.software_version}:${job?.status ?? ""}`;
  if (state.view === "settings" && settingsSignature !== state.settingsSignature) {
    state.settingsSignature = settingsSignature;
    await renderSettings();
  }
  if (state.view === "methods" && signature !== state.methodSignature) {
    state.methodSignature = signature;
    renderMethods();
  }
}

function tick() {
  clock.textContent = new Date().toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" });
}

async function boot() {
  const bootstrap = await fetch("/api/v1/sandbox/bootstrap").then((response) => response.json());
  state.provider = bootstrap.service_provider ?? "simulator";
  const savedToken = sessionStorage.getItem("redface-device-token");
  const savedTerminal = sessionStorage.getItem("redface-terminal-id");
  if (savedToken && savedTerminal) {
    state.token = savedToken;
    state.terminalId = savedTerminal;
  } else {
    state.token = bootstrap.device_token;
    state.terminalId = bootstrap.terminal_id;
  }
  document.querySelector("#terminal-id").textContent = state.terminalId;
  for (const button of document.querySelectorAll("#nav button")) {
    button.onclick = () => {
      if (button.dataset.nav === "home") {
        renderHome();
        refresh().then(() => { if (state.view === "home") renderHome(); }).catch((error) => setError(error.message));
      }
      if (button.dataset.nav === "services") renderServices();
      if (button.dataset.nav === "history") renderHistory().catch((error) => setError(error.message));
      if (button.dataset.nav === "settings") renderSettings().catch((error) => setError(error.message));
    };
  }
  setInterval(async () => {
    tick();
    if (!state.token) return;
    try {
      const beat = await api(`/api/v1/terminals/${state.terminalId}/heartbeat`, {
        method: "POST",
        body: { online: state.online },
      });
      await applyBeat(beat);
    } catch {
      net.textContent = "NO LINK";
      net.dataset.state = "off";
    }
  }, 3000);
  tick();
  const beat = await api(`/api/v1/terminals/${state.terminalId}/heartbeat`, {
    method: "POST",
    body: { online: true },
  });
  await applyBeat(beat);
  await refresh();
  renderHome();
}

function renderMethodsOpen() {
  if (screen.querySelector("[data-method]")) renderMethods();
}

boot().catch((error) => setError(error.message));
