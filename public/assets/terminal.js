const screen = document.querySelector("#screen");
const sandboxError = document.querySelector("#sandbox-error");
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

function setError(message) {
  sandboxError.textContent = message ?? "";
}

function renderHome() {
  if (!guardUnlocked()) return;
  state.view = "home";
  markNav("home");
  const overview = state.overview;
  const job = state.terminal?.update_job;
  const updating = job && job.status !== "COMPLETED" && job.status !== "ROLLED_BACK";
  screen.innerHTML = `
    ${updating ? `<div class="banner" id="update-banner">Software ${job.version}: ${job.status.replaceAll("_", " ")}</div>` : `<div id="update-banner"></div>`}
    <div class="amount">${money(0)}</div>
    <button class="primary" id="new-sale" type="button">NEW SALE</button>
    <div class="stats">
      <div class="stat"><span class="muted">Today's sales</span><b>${overview ? overview.volume_display : "R 0.00"}</b></div>
      <div class="stat"><span class="muted">Transactions</span><b>${overview ? overview.transactions : 0}</b></div>
    </div>`;
  screen.querySelector("#new-sale").onclick = () => {
    if (!guardUnlocked()) return;
    state.amount = 0;
    state.sale = null;
    renderAmount();
  };
}

function renderAmount() {
  if (!guardUnlocked()) return;
  state.view = "amount";
  markNav("home");
  screen.innerHTML = `
    <div class="muted">New sale</div>
    <div class="amount">${money(state.amount)}</div>
    <div class="keys" id="keys"></div>
    <div class="methods">
      <button class="ghost" id="quick-250" type="button">R 250</button>
      <button class="ghost" id="back-home" type="button">Home</button>
    </div>
    <button class="primary" id="continue" type="button">CONTINUE</button>`;
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
  screen.querySelector("#quick-250").onclick = () => {
    state.amount = 25000;
    renderAmount();
  };
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
  const button = (method, label) => `<button class="choice" data-method="${method}" type="button" ${methodAllowed(method) ? "" : "disabled"}>${label}</button>`;
  const cardBlocked = !state.online;
  screen.innerHTML = `
    <div class="amount small">${money(state.amount)}</div>
    ${button("cash", "CASH")}
    ${button("card", "CARD")}
    ${button("tap", "TAP")}
    ${button("qr", "QR")}
    ${cardBlocked ? `<p class="warn">Network lost. Card payments unavailable. Cash sale available.</p>` : ""}
    <button class="ghost" id="back-amount" type="button">Back</button>`;
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
  const label = sale.payment_method === "tap" ? "TAP" : sale.payment_method === "qr" ? "SHOW QR" : "INSERT / TAP / SWIPE";
  screen.innerHTML = `
    <div class="muted">Amount</div>
    <div class="amount small">${sale.amount_display}</div>
    <div class="wait-copy">${label}</div>
    <p>Waiting for card…</p>
    <p class="muted">${sale.id}</p>
    <button class="ghost" id="cancel" type="button">Cancel</button>`;
  setSignals(true);
  screen.querySelector("#cancel").onclick = async () => {
    try {
      const cancelled = await api(`/api/v1/payment-sessions/${sale.session_id}/cancel`, { method: "POST" });
      state.sale = cancelled;
      setSignals(false);
      renderResult(cancelled);
    } catch (error) {
      setError(error.message);
    }
  };
}

function renderResult(sale) {
  state.view = "result";
  markNav("home");
  setSignals(false);
  const unknown = sale.status === "UNKNOWN";
  const approved = sale.status === "COMPLETED";
  const klass = unknown ? "warn" : approved ? "" : "bad";
  const title = approved ? "PAYMENT APPROVED" : unknown ? "STATUS UNKNOWN" : sale.status.replaceAll("_", " ");
  screen.innerHTML = `
    <div class="status-pill ${klass}">${title}</div>
    <div class="amount small">${sale.amount_display}</div>
    <p>${sale.id}</p>
    <p class="muted">${sale.merchant_name} · ${sale.terminal_id}</p>
    ${unknown ? `<p class="warn">The provider may already have taken this payment. Do not start a new sale. Check status.</p>` : ""}
    ${sale.receipt ? `<div class="receipt">${escapeHtml(sale.receipt)}</div>` : ""}
    <button class="primary" id="done" type="button">NEW SALE</button>`;
  document.querySelector("#check-status").disabled = !unknown;
  screen.querySelector("#done").onclick = async () => {
    state.sale = null;
    document.querySelector("#check-status").disabled = true;
    await refresh();
    renderHome();
  };
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function setSignals(enabled) {
  for (const id of ["sig-approve", "sig-decline", "sig-timeout", "sig-network", "sig-provider", "sig-cancel"]) {
    document.querySelector(`#${id}`).disabled = !enabled;
  }
}

async function authorize(signal) {
  if (!state.sale?.session_id) return;
  setError("");
  setSignals(false);
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
    setSignals(true);
    setError(error.message);
  }
}

async function refresh() {
  state.overview = await api("/api/v1/reports/overview");
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
  state.view = "lock";
  markNav("home");
  const status = state.terminal?.status ?? "LOCKED";
  screen.innerHTML = `
    <div class="status-pill bad">${status}</div>
    <p class="wait-copy">This terminal cannot take payments.</p>
    <p class="muted">${state.terminalId}</p>`;
}

async function renderHistory() {
  if (!guardUnlocked()) return;
  state.view = "history";
  markNav("history");
  screen.innerHTML = `<p class="muted">Loading history…</p>`;
  const payload = await api("/api/v1/transactions");
  const rows = payload.transactions;
  screen.innerHTML = `
    <h2>History</h2>
    ${rows.length === 0 ? `<p class="muted">No transactions yet.</p>` : rows.map((tx) => `
      <button class="ghost history-row" type="button" data-id="${tx.id}">
        <span>${tx.amount_display} · ${tx.payment_method}</span>
        <span class="muted">${tx.status}</span>
      </button>`).join("")}`;
  for (const button of screen.querySelectorAll(".history-row")) {
    button.onclick = async () => {
      const tx = await api(`/api/v1/transactions/${button.dataset.id}`);
      renderResult(tx);
    };
  }
}

async function renderSettings() {
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
    ${logs.logs.length === 0 ? `<p class="muted">No logs yet.</p>` : logs.logs.slice(-8).map((entry) => `<p class="log ${entry.level === "warn" ? "warn" : "muted"}">${entry.timestamp.slice(11, 19)} ${escapeHtml(entry.message)}</p>`).join("")}`;
  document.querySelector("#software-version").textContent = `v${terminal.software_version}`;
}

async function applyBeat(beat) {
  state.terminal = beat;
  state.config = beat.config;
  document.querySelector("#software-version").textContent = `v${beat.software_version}`;
  net.textContent = state.online ? beat.status : "OFFLINE";
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
  if (state.view === "settings") await renderSettings();
  if (state.view === "methods" && signature !== state.methodSignature) {
    state.methodSignature = signature;
    renderMethods();
  }
}

function tick() {
  clock.textContent = new Date().toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" });
}

async function boot() {
  const savedToken = sessionStorage.getItem("redface-device-token");
  const savedTerminal = sessionStorage.getItem("redface-terminal-id");
  if (savedToken && savedTerminal) {
    state.token = savedToken;
    state.terminalId = savedTerminal;
  } else {
    const bootstrap = await fetch("/api/v1/sandbox/bootstrap").then((response) => response.json());
    state.token = bootstrap.device_token;
    state.terminalId = bootstrap.terminal_id;
  }
  document.querySelector("#terminal-id").textContent = state.terminalId;
  for (const button of document.querySelectorAll("#nav button")) {
    button.onclick = () => {
      if (button.dataset.nav === "home") renderHome();
      if (button.dataset.nav === "history") renderHistory().catch((error) => setError(error.message));
      if (button.dataset.nav === "settings") renderSettings().catch((error) => setError(error.message));
    };
  }
  document.querySelector("#pair-form").onsubmit = async (event) => {
    event.preventDefault();
    const code = document.querySelector("#pair-code").value.trim();
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
  document.querySelector("#sig-approve").onclick = () => authorize("approve");
  document.querySelector("#sig-decline").onclick = () => authorize("decline");
  document.querySelector("#sig-timeout").onclick = () => authorize("timeout");
  document.querySelector("#sig-network").onclick = () => authorize("network_error");
  document.querySelector("#sig-provider").onclick = () => authorize("provider_failure");
  document.querySelector("#sig-cancel").onclick = () => authorize("cancel");
  document.querySelector("#check-status").onclick = async () => {
    if (!state.sale) return;
    try {
      const sale = await api(`/api/v1/transactions/${state.sale.id}/resolve`, { method: "POST" });
      state.sale = sale;
      renderResult(sale);
      await refresh();
    } catch (error) {
      setError(error.message);
    }
  };
  document.querySelector("#toggle-net").onclick = async () => {
    state.online = !state.online;
    document.querySelector("#toggle-net").textContent = state.online ? "Simulate network lost" : "Restore network";
    const beat = await api(`/api/v1/terminals/${state.terminalId}/heartbeat`, {
      method: "POST",
      body: { online: state.online },
    });
    await applyBeat(beat);
    if (state.view === "methods") renderMethods();
  };
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
