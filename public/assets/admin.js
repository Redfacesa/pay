const cards = document.querySelector("#cards");
const txBody = document.querySelector("#tx-body");
const detail = document.querySelector("#detail");
const terminals = document.querySelector("#terminals");
const terminalManage = document.querySelector("#terminal-manage");
const pairingNote = document.querySelector("#pairing-note");
const merchant = document.querySelector("#merchant");
const recon = document.querySelector("#recon");
const settlement = document.querySelector("#settlement");
const txCount = document.querySelector("#tx-count");
const adminError = document.querySelector("#admin-error");

const state = { token: "", selected: null, transactions: [], managed: "RF-TERM-000001", terminals: [] };

function moneyInputToCents(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100);
}

async function api(path, options = {}) {
  const headers = { authorization: `Bearer ${state.token}`, ...(options.headers ?? {}) };
  if (options.body) headers["content-type"] = "application/json";
  const response = await fetch(path, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message ?? "Request failed");
  return payload;
}

function statusClass(status) {
  if (status === "COMPLETED" || status === "ONLINE") return "ok";
  if (status === "UNKNOWN" || status === "OFFLINE" || status === "PARTIALLY_REFUNDED" || status === "UPDATING") return "warn";
  if (status === "FAILED" || status === "DECLINED" || status === "LOCKED" || status === "DISABLED") return "bad";
  return "";
}

function renderCards(overview) {
  const items = [
    ["Today's volume", overview.volume_display],
    ["Transactions", overview.transactions],
    ["Successful", overview.successful],
    ["Failed", overview.failed],
    ["Refunded", overview.refunded],
  ];
  cards.innerHTML = items.map(([label, value]) => `<article class="card"><span>${label}</span><strong>${value}</strong></article>`).join("");
}

function renderTransactions() {
  txCount.textContent = `${state.transactions.length} shown`;
  txBody.innerHTML = state.transactions.map((tx) => `
    <tr data-id="${tx.id}" class="${state.selected === tx.id ? "selected" : ""}">
      <td>${tx.created_at.slice(11, 19)}</td>
      <td>${tx.terminal_id}<div class="muted">${tx.terminal_location}</div></td>
      <td>${tx.amount_display}</td>
      <td>${tx.payment_method}</td>
      <td class="${statusClass(tx.status)}">${tx.status}</td>
    </tr>`).join("");
  for (const row of txBody.querySelectorAll("tr")) {
    row.onclick = () => {
      state.selected = row.dataset.id;
      renderTransactions();
      renderDetail();
    };
  }
}

function renderDetail() {
  const tx = state.transactions.find((item) => item.id === state.selected);
  if (!tx) {
    detail.innerHTML = "";
    return;
  }
  const canRefund = tx.status === "COMPLETED" || tx.status === "PARTIALLY_REFUNDED";
  detail.innerHTML = `
    <h3>${tx.id}</h3>
    <p>${tx.merchant_name} · ${tx.processor} · ${tx.processor_reference ?? "no provider reference"}</p>
    <p>Refunded ${tx.refunded_display}</p>
    <ol class="timeline">
      ${tx.events.map((event) => `<li><span class="muted">${event.timestamp.slice(11, 19)}</span><span>${event.event_type}</span></li>`).join("")}
    </ol>
    ${tx.status === "UNKNOWN" ? `<button class="choice" id="resolve" type="button">Check with provider</button>` : ""}
    ${canRefund ? `<form class="refund" id="refund-form"><input name="amount" inputmode="decimal" placeholder="Amount in rands" required><input name="reason" placeholder="Reason" required><button class="primary" type="submit">Refund</button></form>` : ""}`;
  const resolve = detail.querySelector("#resolve");
  if (resolve) {
    resolve.onclick = async () => {
      await api(`/api/v1/transactions/${tx.id}/resolve`, { method: "POST" });
      await load();
    };
  }
  const form = detail.querySelector("#refund-form");
  if (form) {
    form.onsubmit = async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const cents = moneyInputToCents(String(data.get("amount")));
      if (!cents) return;
      await api("/api/v1/refunds", {
        method: "POST",
        headers: { "idempotency-key": `refund-${tx.id}-${crypto.randomUUID()}` },
        body: { transaction_id: tx.id, amount: cents, reason: String(data.get("reason")) },
      });
      await load();
    };
  }
}

function renderTerminals(list) {
  terminals.innerHTML = list.map((terminal) => `
    <article class="terminal">
      <div class="row"><strong>${terminal.id}</strong><span class="tag ${statusClass(terminal.status)}">${terminal.status}</span></div>
      <div class="muted">${terminal.location} · ${terminal.software_version}</div>
      <div class="muted">Last seen ${terminal.last_seen ? new Date(terminal.last_seen).toLocaleTimeString("en-ZA") : "never"}</div>
      <div class="actions">
        <button class="ghost" data-manage="${terminal.id}" type="button">Manage</button>
        <button class="ghost" data-action="lock" data-id="${terminal.id}" type="button">Lock</button>
        <button class="ghost" data-action="unlock" data-id="${terminal.id}" type="button">Unlock</button>
      </div>
      ${terminal.pairing_code ? `<p>Pairing code <strong>${terminal.pairing_code}</strong></p>` : ""}
      ${terminal.update_job ? `<p class="muted">Update ${terminal.update_job.version} · ${terminal.update_job.status}</p>` : ""}
    </article>`).join("");
  for (const button of terminals.querySelectorAll("button")) {
    button.onclick = async () => {
      if (button.dataset.manage) {
        state.managed = button.dataset.manage;
        await renderManage();
        return;
      }
      await api(`/api/v1/terminals/${button.dataset.id}/commands`, {
        method: "POST",
        body: { action: button.dataset.action },
      });
      await load();
    };
  }
}

async function renderManage() {
  const terminal = state.terminals.find((item) => item.id === state.managed);
  if (!terminal) {
    terminalManage.innerHTML = "";
    return;
  }
  const detailView = await api(`/api/v1/terminals/${terminal.id}/detail`);
  const key = JSON.stringify({
    id: detailView.id,
    status: detailView.status,
    version: detailView.software_version,
    config: detailView.config,
    job: detailView.update_job,
    health: detailView.health,
  });
  if (key === state.manageKey && terminalManage.querySelector("#config-form")) return;
  state.manageKey = key;
  const flags = [
    ["cash_enabled", "Cash"],
    ["card_enabled", "Card"],
    ["contactless_enabled", "Tap"],
    ["qr_enabled", "QR"],
    ["receipt_enabled", "Receipt"],
    ["auto_update", "Auto-update"],
  ];
  const health = detailView.health;
  const software = detailView.software;
  terminalManage.innerHTML = `
    <h3>${detailView.id}</h3>
    <p><span class="tag ${statusClass(detailView.status)}">${detailView.status}</span> · v${detailView.software_version}</p>
    <p class="muted">${detailView.merchant_name} · ${detailView.device_model}</p>
    <p class="muted">Last heartbeat ${health.last_heartbeat_seconds === null ? "never" : `${health.last_heartbeat_seconds}s ago`}</p>
    <h4>Health</h4>
    <div class="row"><span>Network</span><span class="${statusClass(health.network)}">${health.network}</span></div>
    <div class="row"><span>Application</span><span>${health.application}</span></div>
    <div class="row"><span>Backend</span><span>${health.backend}</span></div>
    <div class="row"><span>Battery</span><span>${health.battery_percent}%</span></div>
    <h4>Software</h4>
    <p>Current ${software.current_version}</p>
    <p class="muted">${software.available_version ? `Available ${software.available_version} · ${software.update_status}` : software.update_status}</p>
    <h4>Configuration</h4>
    <form id="config-form">
      ${flags.map(([keyName, label]) => `<label class="check"><input type="checkbox" name="${keyName}" ${detailView.config[keyName] ? "checked" : ""}> ${label}</label>`).join("")}
      <button class="primary" type="submit">Save configuration</button>
    </form>
    <form id="release-form" class="refund">
      <input name="version" placeholder="1.0.5" required>
      <input name="notes" placeholder="Release notes" required>
      <button class="primary" type="submit">Publish update</button>
    </form>
    <div class="actions">
      <button class="ghost" id="revoke-btn" type="button">Revoke</button>
    </div>
    <h4>History</h4>
    ${(detailView.audit || []).slice(-8).map((entry) => `<p class="log muted">${entry.timestamp.slice(11, 19)} ${escapeHtml(entry.action)}</p>`).join("") || `<p class="muted">No audit yet.</p>`}
    ${(detailView.logs || []).slice(-6).map((entry) => `<p class="log ${entry.level === "warn" ? "warn" : "muted"}">${escapeHtml(entry.message)}</p>`).join("")}`;
  terminalManage.querySelector("#config-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const patch = {};
    for (const [keyName] of flags) patch[keyName] = form.elements[keyName].checked;
    await api(`/api/v1/terminals/${terminal.id}/config`, { method: "PUT", body: patch });
    state.manageKey = "";
    await load();
  };
  terminalManage.querySelector("#release-form").onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await api(`/api/v1/terminals/${terminal.id}/releases`, {
      method: "POST",
      body: { version: String(data.get("version")), notes: String(data.get("notes")) },
    });
    state.manageKey = "";
    await load();
  };
  terminalManage.querySelector("#revoke-btn").onclick = async () => {
    await api(`/api/v1/terminals/${terminal.id}/commands`, { method: "POST", body: { action: "revoke" } });
    state.manageKey = "";
    await load();
  };
}

function renderMerchant(view) {
  if (!view) {
    merchant.innerHTML = "";
    return;
  }
  merchant.innerHTML = `
    <h3>${escapeHtml(view.business_name)}</h3>
    <p class="muted">${view.id} · ${view.status}</p>
    <div class="row"><span>Today's sales</span><strong>${view.today.volume_display}</strong></div>
    <div class="row"><span>Transactions</span><strong>${view.today.transactions}</strong></div>
    <div class="row"><span>Successful</span><strong>${view.today.successful}</strong></div>
    <h4>Terminals</h4>
    ${view.terminals.map((item) => `<div class="row"><span>${item.id}</span><span class="tag ${statusClass(item.status)}">${item.status}</span></div>`).join("")}`;
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderRecon(report) {
  recon.innerHTML = `
    <p>Provider says <strong>${report.provider_count}</strong></p>
    <p>Red Face says <strong>${report.redface_count}</strong></p>
    <p>Matched <strong>${report.matched}</strong> · Exceptions <strong>${report.difference}</strong></p>
    ${report.exceptions.length === 0 ? `<p class="ok">No exceptions.</p>` : report.exceptions.map((item) => `<p class="warn">${item.state}<br>${item.detail}</p>`).join("")}`;
}

function renderServicesPanel(health, orders) {
  const box = document.querySelector("#services");
  box.innerHTML = `
    <p>Provider <strong>${health.provider}</strong> · API ${health.api}</p>
    <p>Wallet ${health.balance_display}</p>
    <p class="muted">Airtime ${health.airtime} · Data ${health.data} · Electricity ${health.electricity} · VAS ${health.vas} · SMS ${health.sms}</p>
    ${orders.length === 0 ? `<p class="muted">No service orders yet.</p>` : orders.slice(0, 6).map((order) => `
      <p>${order.id} · ${order.service_type} · ${order.amount_display} · ${order.status}${order.margin ? ` · margin ${order.margin_display}` : ""}</p>`).join("")}`;
}

function renderSettlement(report) {
  settlement.innerHTML = `
    <p>Gross ${report.gross_display}</p>
    <p>Fees ${report.fees_display}</p>
    <p>Refunds ${report.refunds_display}</p>
    <p>Net <strong>${report.net_display}</strong></p>
    <p class="muted">${report.settlement_date} · ${report.provider_reference}</p>`;
}

async function load() {
  adminError.textContent = "";
  const [overview, tx, terminalList, report, settle, merchants, health, serviceOrders] = await Promise.all([
    api("/api/v1/reports/overview"),
    api("/api/v1/transactions"),
    api("/api/v1/terminals"),
    api("/api/v1/reconciliation"),
    api("/api/v1/settlements"),
    api("/api/v1/merchants"),
    api("/api/v1/services/health"),
    api("/api/v1/services/orders"),
  ]);
  state.transactions = tx.transactions;
  state.terminals = terminalList.terminals;
  if (state.selected && !state.transactions.some((item) => item.id === state.selected)) state.selected = null;
  renderCards(overview);
  renderMerchant(merchants.merchants[0]);
  renderTransactions();
  if (!detail.contains(document.activeElement)) renderDetail();
  renderTerminals(terminalList.terminals);
  await renderManage();
  renderRecon(report);
  renderSettlement(settle);
  renderServicesPanel(health, serviceOrders.orders);
}

async function boot() {
  const bootstrap = await fetch("/api/v1/sandbox/bootstrap").then((response) => response.json());
  state.token = bootstrap.admin_token;
  document.querySelector("#register-form").onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const created = await api("/api/v1/terminals", {
      method: "POST",
      body: { location: String(data.get("location")), device_model: String(data.get("device_model")) },
    });
    pairingNote.textContent = `${created.id} pairing code ${created.pairing_code}`;
    event.currentTarget.reset();
    state.managed = created.id;
    await load();
  };
  await load();
  setInterval(() => {
    load().catch((error) => {
      adminError.textContent = error.message;
    });
  }, 4000);
}

boot().catch((error) => {
  adminError.textContent = error.message;
});
