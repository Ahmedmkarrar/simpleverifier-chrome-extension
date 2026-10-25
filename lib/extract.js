/**
 * Pure helpers for the popup: pull emails and phone numbers out of page text,
 * build CSV, and pace live checks. No chrome.* or DOM access, so they run under
 * `node --test` as well as in the extension.
 */

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/g;

/** Endings that make "logo@2x.png" look like an address. */
const ASSET_ENDINGS = /\.(png|jpe?g|gif|webp|svg|avif|ico|bmp|css|js|mjs|map|woff2?|ttf|otf|mp4|webm|mov|pdf)$/i;

/** Placeholder addresses that sit in page templates and forms, never real contacts. */
const PLACEHOLDER_LOCALS = new Set(["you", "your", "yourname", "your.name", "name", "user", "username", "email", "example"]);
const PLACEHOLDER_DOMAINS = new Set(["example.com", "example.org", "example.net", "domain.com", "email.com", "yourdomain.com", "company.com"]);

export const MAX_ITEMS = 500;

function cleanEmail(raw) {
  const value = raw.trim().replace(/^mailto:/i, "").replace(/^[.\-_]+|[.\-_]+$/g, "").toLowerCase();
  const at = value.lastIndexOf("@");
  if (at < 1 || value.indexOf("@") !== at) return null;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64 || value.length > 254) return null;
  if (local.includes("..") || domain.includes("..")) return null;
  if (ASSET_ENDINGS.test(domain)) return null;
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  if (!/^[a-z]{2,24}$|^xn--[a-z0-9-]+$/.test(tld)) return null;
  if (PLACEHOLDER_DOMAINS.has(domain) && PLACEHOLDER_LOCALS.has(local)) return null;
  return value;
}

/** The address part of a mailto: link, decoded, without ?subject= and friends. */
function mailtoAddresses(href) {
  const body = href.replace(/^mailto:/i, "").split("?")[0];
  let decoded = body;
  try {
    decoded = decodeURIComponent(body);
  } catch {
    // A malformed escape: fall back to the raw text.
  }
  return decoded.split(/[,;]/);
}

/**
 * Unique addresses found in the page text and mailto: links, in the order
 * they first appear, capped at MAX_ITEMS.
 */
export function extractEmails(text, mailtoHrefs = []) {
  const found = new Set();
  const add = (raw) => {
    if (found.size >= MAX_ITEMS) return;
    const email = cleanEmail(raw);
    if (email) found.add(email);
  };
  for (const href of mailtoHrefs) mailtoAddresses(href).forEach(add);
  for (const match of String(text ?? "").matchAll(EMAIL_PATTERN)) add(match[0]);
  return [...found];
}

/**
 * Phone-shaped runs of text: an optional +, then digits with spaces, dots,
 * dashes or brackets between them. Validation is libphonenumber's job (lib/checks);
 * this only finds candidates.
 */
const PHONE_PATTERN = /(?:\+|\b00)?\(?\d[\d\s().-]{5,20}\d\b/g;

function digitsOf(value) {
  return value.replace(/\D/g, "");
}

/** A candidate written the way people write phone numbers, not a date, price or ID. */
function looksLikePhone(raw) {
  const value = raw.trim();
  const digits = digitsOf(value);
  if (digits.length < 7 || digits.length > 15) return false;
  if (/^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/.test(value) || /^\d{1,2}[-./]\d{1,2}[-./]\d{2,4}$/.test(value)) return false;
  if (/^\d+\.\d+$/.test(value)) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  if (value.startsWith("+")) return true;
  // Without a +, ask for separators the way phone numbers are grouped: 555-123-4567, (555) 123 4567.
  return /[\s().-]/.test(value) && value.split(/[\s().-]+/).filter(Boolean).length >= 2;
}

function cleanTel(href) {
  let value = href.replace(/^tel:/i, "");
  try {
    value = decodeURIComponent(value);
  } catch {
    // keep the raw value
  }
  return value.split(/[;,?]/)[0].trim();
}

/**
 * Unique phone numbers from tel: links first, then from the page text, keyed
 * by their digits so "+1 555 123 4567" and "(555) 123-4567" written twice
 * count once each. Returns the number as written.
 */
export function extractPhones(text, telHrefs = []) {
  const byDigits = new Map();
  const add = (raw) => {
    if (byDigits.size >= MAX_ITEMS) return;
    const value = raw.trim().replace(/[\s.-]+$/, "");
    const digits = digitsOf(value);
    if (digits.length < 7 || digits.length > 15) return;
    if (!byDigits.has(digits)) byDigits.set(digits, value);
  };
  for (const href of telHrefs) add(cleanTel(href));
  for (const match of String(text ?? "").matchAll(PHONE_PATTERN)) {
    if (looksLikePhone(match[0])) add(match[0]);
  }
  return [...byDigits.values()];
}

/** Quotes a CSV cell and defuses spreadsheet formulas (=, @, tab, CR) on import. */
export function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers, rows) {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** The live-check route allows 120 calls a minute per account, so one every 500 ms at most. A little slack on top. */
export const MIN_INTERVAL_MS = 520;

/**
 * Runs `worker` over `items` one at a time, at most one start per
 * `intervalMs`. `shouldStop` is checked before each item. Resolves with the
 * results in input order (undefined for items skipped by a stop).
 */
export async function runPaced(items, worker, { intervalMs = MIN_INTERVAL_MS, shouldStop = () => false, onResult = () => {}, sleep = defaultSleep, now = Date.now } = {}) {
  const results = new Array(items.length);
  let lastStart = -Infinity;
  for (let index = 0; index < items.length; index++) {
    if (shouldStop()) break;
    const wait = lastStart + intervalMs - now();
    if (wait > 0) await sleep(wait);
    if (shouldStop()) break;
    lastStart = now();
    results[index] = await worker(items[index], index);
    onResult(results[index], index);
  }
  return results;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
