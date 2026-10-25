/**
 * Calls to simpleverifier.com. Two ways to be signed in:
 * - the site's sign-in cookie (Google sign-in on simpleverifier.com), which
 *   uses /api/extension/* and the free monthly live checks; or
 * - an API key the user pastes into the popup, which uses the public API
 *   (/api/v1/*) and the key's plan limits.
 * The API key, when set, wins.
 */
import { SITE } from "./config.js";

const TIMEOUT_MS = 35_000;
const API_KEY_STORAGE = "svApiKey";

export class ApiError extends Error {
  constructor(status, message, body = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function call(path, init = {}, apiKey = "") {
  const headers = { "X-SV-Extension": "1" };
  if (init.body) headers["Content-Type"] = "application/json";
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let response;
  try {
    response = await fetch(`${SITE}${path}`, {
      ...init,
      headers,
      credentials: apiKey ? "omit" : "include",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ApiError(0, "Couldn't reach SimpleVerifier. Check your connection and try again.");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, body.error || `Request failed (${response.status}).`, body);
  return body;
}

export async function getApiKey() {
  const stored = await chrome.storage.local.get(API_KEY_STORAGE);
  return typeof stored[API_KEY_STORAGE] === "string" ? stored[API_KEY_STORAGE] : "";
}

export function clearApiKey() {
  return chrome.storage.local.remove(API_KEY_STORAGE);
}

function keyAccount(me) {
  return { signedIn: true, paid: true, viaKey: true, email: me.email ?? "", plan: me.plan ?? "" };
}

/** Checks a pasted key with GET /api/v1/me (never billed) and saves it only if it works. */
export async function connectApiKey(rawKey) {
  const key = rawKey.trim();
  if (!key) throw new ApiError(400, "Paste your API key first.");
  const me = await call("/api/v1/me", {}, key);
  await chrome.storage.local.set({ [API_KEY_STORAGE]: key });
  return keyAccount(me);
}

/** { signedIn, paid?, viaKey?, plan?, limit?, used?, remaining?, resetsAt?, storeUrl } */
export async function getAccount() {
  const key = await getApiKey();
  if (key) return keyAccount(await call("/api/v1/me", {}, key));
  return call("/api/extension/usage");
}

/**
 * One live mailbox check. With an API key it is one call on the key's plan;
 * otherwise unpaid accounts spend one of the month's free live checks.
 */
export async function liveCheck(email) {
  const key = await getApiKey();
  const path = key ? "/api/v1/verify" : "/api/extension/verify";
  return call(path, { method: "POST", body: JSON.stringify({ email }) }, key);
}
