import { ApiError, clearApiKey, connectApiKey, getAccount, liveCheck } from "./lib/api.js";
import { domainAcceptsMail, domainInfo, localEmailCheck, pageDomain, phoneInfo } from "./lib/checks.js";
import { API_KEYS_URL, PENDING_STORAGE, PRIVACY_URL, RATING_AFTER_USES, SIGN_IN_URL, siteUrl } from "./lib/config.js";
import { extractEmails, extractPhones, runPaced, toCsv } from "./lib/extract.js";
import { setTelemetry, telemetryEnabled, track } from "./lib/telemetry.js";

const COUNTRY_STORAGE = "svCountry";
const USES_STORAGE = "svUses";
const RATING_DONE_STORAGE = "svRatingDone";
const RATING_SHOWN_STORAGE = "svRatingShownTracked";
const COUNTRIES = ["US", "CA", "GB", "IE", "AU", "NZ", "DE", "FR", "ES", "IT", "NL", "BE", "SE", "CH", "IN", "AE", "SA", "SG", "ZA", "BR", "MX"];

const $ = (id) => document.getElementById(id);

const UNAVAILABLE = "Signed in. Live checks aren't available right now; the free checks still work.";

function liveUnavailable() {
  return state.account?.signedIn === true && !state.account.paid && state.account.unavailable === true;
}

const state = {
  /** null until /api/extension/usage answers; { signedIn: false } when offline or signed out. */
  account: null,
  tab: null,
  emails: [],
  phones: [],
  local: new Map(),
  live: new Map(),
  running: false,
  stop: false,
};

/* ------------------------------------------------------------ helpers */

function setMessage(element, text, isError = false) {
  element.textContent = text;
  element.classList.toggle("error", isError);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function pill(status, label = status) {
  return el("span", `pill ${status}`, label);
}

function openTab(url) {
  chrome.tabs.create({ url });
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function isPaid() {
  return state.account?.signedIn === true && state.account.paid === true;
}

function remainingFree() {
  if (!state.account?.signedIn) return 0;
  if (state.account.paid) return Infinity;
  return typeof state.account.remaining === "number" ? state.account.remaining : 0;
}

function resetDate() {
  const iso = state.account?.resetsAt;
  if (!iso) return "next month";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", timeZone: "UTC" });
}

async function countUse() {
  const stored = await chrome.storage.local.get(USES_STORAGE);
  const uses = (Number(stored[USES_STORAGE]) || 0) + 1;
  await chrome.storage.local.set({ [USES_STORAGE]: uses });
  if (uses >= RATING_AFTER_USES) maybeShowRating();
}

/* ------------------------------------------------------------ account */

function renderAccount() {
  const text = $("account-text");
  const button = $("sign-in-btn");
  const chip = $("plan-chip");
  const account = state.account;
  $("key-open").hidden = true;
  $("key-remove").hidden = true;
  button.hidden = true;
  chip.hidden = true;
  chip.classList.remove("pro");

  if (!account) {
    text.textContent = "Checking your account…";
    return;
  }
  if (account.keyRejected) {
    text.textContent = account.keyError || "Your API key didn't work. Remove it or paste a new one.";
    $("key-remove").hidden = false;
    return;
  }
  if (account.offline) {
    text.textContent = "Couldn't reach simpleverifier.com. Free checks still work.";
    return;
  }
  if (!account.signedIn) {
    text.textContent = "Sign in free for 50 live mailbox checks a month.";
    button.hidden = false;
    $("key-open").hidden = false;
    return;
  }
  if (account.viaKey) {
    chip.hidden = false;
    chip.textContent = planName(account.plan);
    chip.classList.add("pro");
    text.textContent = "API key connected. Live checks use your plan's API calls.";
    $("key-remove").hidden = false;
    return;
  }
  if (account.paid) {
    chip.hidden = false;
    chip.textContent = "Pro";
    chip.classList.add("pro");
    text.textContent = "More live mailbox checks a month.";
    return;
  }
  if (account.unavailable) {
    text.textContent = UNAVAILABLE;
    return;
  }
  chip.hidden = false;
  chip.textContent = "Free";
  text.textContent = `${account.remaining} of ${account.limit} free live checks left this month.`;
}

function planName(plan) {
  if (!plan || typeof plan !== "string") return "API";
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

async function loadAccount() {
  try {
    state.account = await getAccount();
  } catch (error) {
    const rejected = error instanceof ApiError && (error.status === 401 || error.status === 402);
    state.account = rejected ? { signedIn: false, keyRejected: true, keyError: error.message } : { signedIn: false, offline: true };
  }
  renderAccount();
  renderQuotaNote();
  maybeShowRating();
}

function updateUsage(body) {
  if (!state.account?.signedIn || state.account.paid || typeof body?.remaining !== "number") return;
  Object.assign(state.account, { limit: body.limit, used: body.used, remaining: body.remaining, resetsAt: body.resetsAt ?? state.account.resetsAt });
  renderAccount();
}

function signIn() {
  openTab(SIGN_IN_URL);
}

function showKeyForm(show) {
  $("key-form").hidden = !show;
  setMessage($("key-msg"), "");
  if (show) $("key-input").focus();
}

async function saveKey(event) {
  event.preventDefault();
  const button = $("key-save");
  button.disabled = true;
  setMessage($("key-msg"), "Checking the key…");
  try {
    state.account = await connectApiKey($("key-input").value);
    $("key-input").value = "";
    showKeyForm(false);
    renderAccount();
    renderEmails();
  } catch (error) {
    setMessage($("key-msg"), error instanceof ApiError ? error.message : "Couldn't check the key.", true);
  } finally {
    button.disabled = false;
  }
}

async function removeKey() {
  await clearApiKey();
  state.account = null;
  renderAccount();
  await loadAccount();
}

/* ------------------------------------------------------------- upsell */

function upgrade(location) {
  track("upgrade_clicked", { location, target: "pricing" });
  openTab(siteUrl("/pricing", location));
}

async function fullListReport(location) {
  track("upgrade_clicked", { location, target: "full_list_report" });
  if (state.emails.length) {
    try {
      await navigator.clipboard.writeText(state.emails.join("\n"));
    } catch {
      // The report page still opens; the list can be exported instead.
    }
  }
  openTab(siteUrl("/verify", location));
}

function showLimitCard() {
  const pending = state.emails.filter((email) => !state.live.has(email)).length;
  const lead = `You've used this month's ${state.account?.limit ?? 50} free live checks. They reset on ${resetDate()}.`;
  $("limit-text").textContent = pending
    ? `${lead} ${plural(pending, "email")} on this page ${pending === 1 ? "is" : "are"} still unchecked. Pro verifies without a monthly cap, or run them as a full list report.`
    : `${lead} Pro verifies without a monthly cap.`;
  $("limit-card").hidden = false;
  track("limit_reached", { pending });
}

function renderQuotaNote() {
  const note = $("quota-note");
  const pending = state.emails.filter((email) => !state.live.has(email)).length;
  note.replaceChildren();
  note.hidden = true;
  if (!pending || isPaid()) return;
  if (!state.account?.signedIn) {
    note.append(`Live checks need a free account: ${plural(50, "check")} a month.`);
    const link = el("button", "link", "Sign in");
    link.type = "button";
    link.addEventListener("click", signIn);
    note.append(link);
    note.hidden = state.account === null;
    return;
  }
  if (liveUnavailable()) return;
  const left = remainingFree();
  if (pending <= left) return;
  note.append(`${plural(pending, "email")} here, ${left} free live ${left === 1 ? "check" : "checks"} left this month. Verify all checks the first ${left}.`);
  const link = el("button", "link", "Pro checks them all");
  link.type = "button";
  link.addEventListener("click", () => upgrade("verify_all_note"));
  note.append(link);
  note.hidden = false;
}

/* --------------------------------------------------------------- tabs */

function selectTab(which) {
  const page = which === "page";
  $("tab-page").setAttribute("aria-selected", String(page));
  $("tab-one").setAttribute("aria-selected", String(!page));
  $("tab-page").tabIndex = page ? 0 : -1;
  $("tab-one").tabIndex = page ? -1 : 0;
  $("panel-page").hidden = !page;
  $("panel-one").hidden = page;
  (page ? $("tab-page") : $("tab-one")).focus();
  if (!page) $("one-input").focus();
}

function onTabKey(event) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  selectTab($("tab-page").getAttribute("aria-selected") === "true" ? "one" : "page");
}

/* -------------------------------------------------------- domain card */

function tag(text, on) {
  return el("span", `tag ${on ? "yes" : "no"}`, `${on ? "✓" : "✗"} ${text}`);
}

async function loadDomainCard() {
  const domain = state.tab?.url ? pageDomain(state.tab.url) : null;
  if (!domain) return;
  $("domain-card").hidden = false;
  $("domain-name").textContent = domain;
  const body = $("domain-body");
  try {
    let info = await domainInfo(domain);
    const parent = domain.split(".").slice(1).join(".");
    if (!info.acceptsMail && parent.includes(".")) {
      const parentInfo = await domainInfo(parent).catch(() => null);
      if (parentInfo?.acceptsMail) {
        info = parentInfo;
        $("domain-name").textContent = parent;
      }
    }
    const provider = el("span", "provider");
    if (!info.acceptsMail) provider.textContent = "No mail server (no MX record)";
    else if (info.provider && info.providerRole === "gateway") {
      const behind = info.spfHints.length ? `, mailboxes likely on ${info.spfHints.join(" or ")}` : "";
      provider.textContent = `Mail filtered by ${info.provider}${behind}`;
    } else if (info.provider && info.providerRole === "forwarding") provider.textContent = `Mail forwarded by ${info.provider}`;
    else if (info.provider) provider.textContent = `Email hosted by ${info.provider}`;
    else provider.textContent = `Own or unlisted mail host (${info.mxHost})`;
    const dmarcLabel = info.dmarc ? `DMARC${info.dmarcPolicy ? ` (p=${info.dmarcPolicy})` : ""}` : "DMARC";
    body.classList.remove("muted");
    body.replaceChildren(provider, tag("MX", info.acceptsMail), tag("SPF", info.spf), tag(dmarcLabel, info.dmarc));
  } catch {
    body.textContent = "Couldn't look up this domain's mail records.";
  }
}

/* ---------------------------------------------------------- page scan */

/** Runs in the page (injected on click via activeTab). Returns raw text and link targets only. */
function collectPage() {
  const text = (document.body?.innerText ?? "").slice(0, 2_000_000);
  const hrefs = (selector) => [...document.querySelectorAll(selector)].slice(0, 2000).map((a) => a.getAttribute("href") ?? "");
  return { text, mailto: hrefs('a[href^="mailto:" i]'), tel: hrefs('a[href^="tel:" i]') };
}

async function scanPage() {
  const msg = $("scan-msg");
  setMessage(msg, "Reading this page…");
  let page;
  try {
    if (!state.tab?.id) throw new Error("no tab");
    const [injection] = await chrome.scripting.executeScript({ target: { tabId: state.tab.id }, func: collectPage });
    page = injection?.result;
  } catch {
    setMessage(msg, "Chrome doesn't let extensions read this page (for example the Web Store or chrome:// pages). Try it on a regular website.", true);
    return;
  }
  if (!page) {
    setMessage(msg, "Couldn't read this page.", true);
    return;
  }

  state.emails = extractEmails(page.text, page.mailto);
  state.phones = extractPhones(page.text, page.tel);
  state.local = new Map(state.emails.map((email) => [email, localEmailCheck(email)]));
  state.live.clear();
  $("limit-card").hidden = true;
  const found = [];
  if (state.emails.length) found.push(plural(state.emails.length, "email"));
  if (state.phones.length) found.push(plural(state.phones.length, "phone number"));
  setMessage(msg, found.length ? `Found ${found.join(" and ")}.` : "No emails or phone numbers found on this page.");
  track("finder_run", { emails_found: state.emails.length, phones_found: state.phones.length });
  if (found.length) countUse();
  renderEmails();
  renderPhones();
}

function liveRow(email) {
  const li = el("li");
  const left = el("span", "value", email);
  const meta = el("span", "meta");
  const live = state.live.get(email);
  const local = state.local.get(email);
  if (live) {
    meta.append(pill(live.badge, live.label ?? live.badge));
    if (live.reason) meta.append(el("span", "detail", live.reason));
  } else if (local) {
    const actions = el("span", "actions");
    actions.append(pill(local.badge, local.label));
    if (local.badge !== "invalid") {
      const button = el("button", "btn tiny ghost", "Verify");
      button.type = "button";
      button.disabled = state.running;
      button.addEventListener("click", () => verifyList([email]));
      actions.append(button);
    }
    meta.append(actions);
    if (local.notes[0] && local.badge !== "neutral") meta.append(el("span", "detail", local.notes[0]));
  }
  li.append(left, meta);
  return li;
}

function renderEmails() {
  $("emails-block").hidden = state.emails.length === 0;
  $("email-count").textContent = `(${state.emails.length})`;
  const pending = state.emails.filter((email) => !state.live.has(email) && state.local.get(email)?.badge !== "invalid").length;
  $("verify-all").textContent = pending ? `Verify all ${pending}` : "All verified";
  $("verify-all").disabled = state.running || pending === 0;
  $("email-list").replaceChildren(...state.emails.map(liveRow));
  renderQuotaNote();
}

function renderPhones() {
  $("phones-block").hidden = state.phones.length === 0;
  $("phone-count").textContent = `(${state.phones.length})`;
  const country = $("country").value;
  $("phone-list").replaceChildren(
    ...state.phones.map((phone) => {
      const info = phoneInfo(phone, country);
      const li = el("li");
      const meta = el("span", "meta");
      meta.append(pill(info.valid ? "valid" : "invalid", info.valid ? "format ok" : "bad format"));
      const detail = info.valid ? [info.e164, info.country, info.type].filter(Boolean).join(" · ") : "Doesn't fit the numbering plan";
      meta.append(el("span", "detail", detail));
      li.append(el("span", "value", phone), meta);
      return li;
    }),
  );
}

/* --------------------------------------------------------- live checks */

function setRunning(running) {
  state.running = running;
  $("scan-btn").disabled = running;
  $("stop-btn").hidden = !running;
  renderEmails();
}

function liveResult(body) {
  const status = ["valid", "risky", "invalid"].includes(body.status) ? body.status : "risky";
  return { badge: status, label: status, status, reason: body.reason ?? "" };
}

/** Live-checks `emails` in order, within the free allowance; shows the limit card when it runs out. */
async function verifyList(emails) {
  if (state.running || emails.length === 0) return;
  if (!state.account?.signedIn) {
    renderQuotaNote();
    setMessage($("scan-msg"), "Sign in with Google (free) to run live mailbox checks.", true);
    $("sign-in-btn").focus();
    return;
  }
  if (liveUnavailable()) {
    setMessage($("scan-msg"), UNAVAILABLE, true);
    return;
  }
  const left = remainingFree();
  if (left <= 0) {
    showLimitCard();
    return;
  }
  const batch = emails.slice(0, left === Infinity ? emails.length : left);
  state.stop = false;
  setRunning(true);
  let limited = false;
  try {
    await runPaced(batch, async (email) => {
      try {
        const body = await liveCheck(email);
        state.live.set(email, liveResult(body));
        updateUsage(body);
        track("live_check", { result: state.live.get(email).status, plan: isPaid() ? "paid" : "free", batch: batch.length > 1 });
        countUse();
      } catch (error) {
        if (state.account?.viaKey && error instanceof ApiError && (error.status === 401 || error.status === 402 || error.status === 429)) {
          setMessage($("scan-msg"), error.message, true);
          state.stop = true;
        } else if (error instanceof ApiError && error.status === 402) {
          updateUsage(error.body);
          limited = true;
          state.stop = true;
        } else if (error instanceof ApiError && error.status === 503 && error.body?.unavailable) {
          state.account = { ...state.account, unavailable: true };
          renderAccount();
          state.stop = true;
          setMessage($("scan-msg"), UNAVAILABLE, true);
        } else if (error instanceof ApiError && error.status === 401) {
          state.account = { signedIn: false };
          renderAccount();
          state.stop = true;
          setMessage($("scan-msg"), "You're signed out on simpleverifier.com. Sign in again to keep checking.", true);
        } else {
          setMessage($("scan-msg"), error instanceof ApiError ? error.message : "Check failed.", true);
          if (!(error instanceof ApiError) || error.status === 0 || error.status >= 500) state.stop = true;
        }
      }
      renderEmails();
    }, { shouldStop: () => state.stop });
  } finally {
    setRunning(false);
  }
  if (!isPaid() && (limited || (batch.length < emails.length && remainingFree() <= 0))) showLimitCard();
}

function verifyAll() {
  const pending = state.emails.filter((email) => !state.live.has(email) && state.local.get(email)?.badge !== "invalid");
  return verifyList(pending);
}

/* -------------------------------------------------------- single check */

async function checkOne(event) {
  event.preventDefault();
  const value = $("one-input").value.trim();
  const box = $("one-result");
  box.replaceChildren();
  if (!value) return;
  if (value.includes("@")) return checkOneEmail(box, value);
  return checkOnePhone(box, value);
}

function checkOnePhone(box, value) {
  const info = phoneInfo(value, $("country").value);
  const line = el("div", "row");
  line.append(pill(info.valid ? "valid" : "invalid", info.valid ? "format ok" : "bad format"), el("span", "email", info.international || value));
  const checks = el("ul", "checks");
  if (info.valid) {
    checks.append(el("li", "", `E.164: ${info.e164}`), el("li", "", `Country: ${info.country || "unknown"}`));
    if (info.type) checks.append(el("li", "", `Line type in the numbering plan: ${info.type}`));
  } else {
    checks.append(el("li", "", `Doesn't fit the numbering plan (numbers without + are read as ${$("country").value}).`));
  }
  checks.append(el("li", "", "A format check can't tell you if the number is in service."));
  box.replaceChildren(line, checks);
  countUse();
}

async function checkOneEmail(box, value) {
  const local = localEmailCheck(value);
  const line = el("div", "row");
  line.append(pill(local.badge, local.label), el("span", "email", local.email));
  const checks = el("ul", "checks");
  for (const note of local.notes) checks.append(el("li", "", note));
  box.replaceChildren(line, checks);
  countUse();
  if (local.badge === "invalid") return;

  const mailItem = el("li", "", "Looking up the domain's mail server…");
  checks.append(mailItem);
  const domain = local.email.slice(local.email.lastIndexOf("@") + 1).toLowerCase();
  const accepts = await domainAcceptsMail(domain);
  if (accepts === false) {
    mailItem.textContent = `${domain} has no mail server, so nothing can be delivered there.`;
    line.firstChild.replaceWith(pill("invalid", "no mail server"));
    return;
  }
  mailItem.textContent = accepts ? `${domain} has a mail server (MX record).` : "Couldn't look up the domain's mail server.";

  const live = el("div", "live");
  renderLiveSlot(live, local.email);
  box.append(live);
}

function renderLiveSlot(slot, email) {
  slot.replaceChildren();
  if (!state.account) {
    slot.append(el("p", "muted", "Checking your account…"));
    accountReady.then(() => renderLiveSlot(slot, email));
    return;
  }
  if (!state.account.signedIn) {
    slot.append(el("p", "muted", "A live check asks the mail server whether this mailbox exists. Free with Google sign-in, 50 a month, or connect an API key."));
    const button = el("button", "btn small primary", "Sign in with Google");
    button.type = "button";
    button.addEventListener("click", signIn);
    slot.append(button);
    return;
  }
  if (liveUnavailable()) {
    slot.append(el("p", "muted", "Live mailbox checks aren't available right now. The checks above are free and still work."));
    return;
  }
  if (remainingFree() <= 0) {
    slot.append(el("p", "muted", `This month's free live checks are used up. They reset on ${resetDate()}.`));
    const button = el("button", "btn small primary", "See plans");
    button.type = "button";
    button.addEventListener("click", () => upgrade("single_limit"));
    slot.append(button);
    track("limit_reached", { pending: 1 });
    return;
  }
  const button = el("button", "btn small primary", "Run live mailbox check");
  button.type = "button";
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Checking…";
    try {
      const body = await liveCheck(email);
      updateUsage(body);
      const result = liveResult(body);
      track("live_check", { result: result.status, plan: isPaid() ? "paid" : "free", batch: false });
      countUse();
      const row = el("div", "row");
      row.append(pill(result.badge, result.label), el("span", "reason", result.reason));
      slot.replaceChildren(row);
    } catch (error) {
      if (state.account?.viaKey && error instanceof ApiError) {
        button.disabled = false;
        button.textContent = "Run live mailbox check";
        slot.append(el("p", "msg error", error.message));
        return;
      }
      if (error instanceof ApiError && error.status === 402) {
        updateUsage(error.body);
        renderLiveSlot(slot, email);
        return;
      }
      if (error instanceof ApiError && error.status === 401) {
        state.account = { signedIn: false };
        renderAccount();
        renderLiveSlot(slot, email);
        return;
      }
      if (error instanceof ApiError && error.status === 503 && error.body?.unavailable) {
        state.account = { ...state.account, unavailable: true };
        renderAccount();
        renderLiveSlot(slot, email);
        return;
      }
      button.disabled = false;
      button.textContent = "Run live mailbox check";
      slot.append(el("p", "msg error", error instanceof ApiError ? error.message : "Check failed."));
    }
  });
  slot.append(button);
}

/* ------------------------------------------------------ copy and CSV */

function download(filename, csv) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyLines(lines, button) {
  await navigator.clipboard.writeText(lines.join("\n"));
  const label = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => (button.textContent = label), 1200);
}

function emailCsv() {
  return toCsv(
    ["email", "live_status", "live_reason", "in_browser_check", "notes"],
    state.emails.map((email) => {
      const live = state.live.get(email);
      const local = state.local.get(email);
      return [email, live?.status ?? "", live?.reason ?? "", local?.label ?? "", local?.notes.join("; ") ?? ""];
    }),
  );
}

function phoneCsv() {
  const country = $("country").value;
  return toCsv(
    ["phone", "format", "e164", "country", "type"],
    state.phones.map((phone) => {
      const info = phoneInfo(phone, country);
      return [phone, info.valid ? "valid format" : "invalid format", info.e164, info.country, info.type];
    }),
  );
}

/* ------------------------------------------------------------- rating */

async function maybeShowRating() {
  const storeUrl = state.account?.storeUrl;
  if (!storeUrl || !/^https:\/\/chromewebstore\.google\.com\//.test(storeUrl)) return;
  const stored = await chrome.storage.local.get([USES_STORAGE, RATING_DONE_STORAGE, RATING_SHOWN_STORAGE]);
  if (stored[RATING_DONE_STORAGE] || (Number(stored[USES_STORAGE]) || 0) < RATING_AFTER_USES) return;
  if (!$("rate-line").hidden) return;
  $("rate-line").hidden = false;
  if (!stored[RATING_SHOWN_STORAGE]) {
    chrome.storage.local.set({ [RATING_SHOWN_STORAGE]: true });
    track("rating_prompt_shown");
  }
}

function closeRating() {
  $("rate-line").hidden = true;
  return chrome.storage.local.set({ [RATING_DONE_STORAGE]: true });
}

/* --------------------------------------------------------------- init */

let accountReady = Promise.resolve();

/** An address picked from the right-click menu: open Check one with it filled in. */
async function takePendingCheck() {
  const stored = await chrome.storage.session.get(PENDING_STORAGE);
  const value = stored[PENDING_STORAGE];
  if (typeof value !== "string" || !value) return;
  await chrome.storage.session.remove(PENDING_STORAGE);
  await chrome.action.setBadgeText({ text: "" });
  selectTab("one");
  $("one-input").value = value;
  $("one-form").requestSubmit();
}

async function init() {
  const stored = await chrome.storage.local.get(COUNTRY_STORAGE);
  const select = $("country");
  for (const code of COUNTRIES) select.append(new Option(code, code));
  select.value = COUNTRIES.includes(stored[COUNTRY_STORAGE]) ? stored[COUNTRY_STORAGE] : "US";
  $("telemetry-toggle").checked = await telemetryEnabled();
  $("privacy-link").href = PRIVACY_URL;

  $("sign-in-btn").addEventListener("click", signIn);
  $("key-open").addEventListener("click", () => showKeyForm(true));
  $("key-cancel").addEventListener("click", () => showKeyForm(false));
  $("key-where").addEventListener("click", () => openTab(API_KEYS_URL));
  $("key-form").addEventListener("submit", saveKey);
  $("key-remove").addEventListener("click", removeKey);
  $("tab-page").addEventListener("click", () => selectTab("page"));
  $("tab-one").addEventListener("click", () => selectTab("one"));
  $("tab-page").addEventListener("keydown", onTabKey);
  $("tab-one").addEventListener("keydown", onTabKey);
  $("scan-btn").addEventListener("click", scanPage);
  $("verify-all").addEventListener("click", verifyAll);
  $("stop-btn").addEventListener("click", () => (state.stop = true));
  $("one-form").addEventListener("submit", checkOne);
  $("country").addEventListener("change", () => {
    chrome.storage.local.set({ [COUNTRY_STORAGE]: select.value });
    renderPhones();
  });
  $("copy-emails").addEventListener("click", (e) => copyLines(state.emails, e.currentTarget));
  $("copy-phones").addEventListener("click", (e) => copyLines(state.phones, e.currentTarget));
  $("csv-emails").addEventListener("click", () => download("simpleverifier-emails.csv", emailCsv()));
  $("csv-phones").addEventListener("click", () => download("simpleverifier-phones.csv", phoneCsv()));
  $("report-btn").addEventListener("click", () => fullListReport("full_list_report"));
  $("limit-pro").addEventListener("click", () => upgrade("limit_card"));
  $("limit-report").addEventListener("click", () => fullListReport("limit_card"));
  $("rate-btn").addEventListener("click", async () => {
    track("rating_prompt_clicked");
    openTab(state.account.storeUrl);
    await closeRating();
  });
  $("rate-dismiss").addEventListener("click", closeRating);
  $("telemetry-toggle").addEventListener("change", (e) => setTelemetry(e.currentTarget.checked));

  [state.tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  loadDomainCard();
  accountReady = loadAccount();
  takePendingCheck();
}

init();
