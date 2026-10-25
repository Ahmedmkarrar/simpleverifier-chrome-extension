/**
 * Free checks that run without an account: in the browser from the site's own
 * data (bundled into vendor.js), plus public DNS-over-HTTPS for mail records.
 * No chrome.* access, so `node --test` can run them with a stubbed fetch.
 */
import {
  classifyMxHost,
  classifyRole,
  fixAddress,
  isDisposableDomain,
  isValidSyntax,
  mailboxKind,
  parsePhoneNumberFromString,
  spfProviders,
} from "./vendor.js";
import { DOH_URL } from "./config.js";

function domainOf(email) {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

/**
 * What can be said about an address without contacting its mail server.
 * Never says an address works; at best "format ok", and the live check is the
 * only thing that looks at the mailbox.
 */
export function localEmailCheck(raw) {
  const email = String(raw ?? "").trim();
  const fix = fixAddress(email);
  const suggestion = fix && fix.fixed.toLowerCase() !== email.toLowerCase() ? fix.fixed : null;
  if (!isValidSyntax(email)) {
    return { email, badge: "invalid", label: "bad syntax", notes: ["Not a valid address format"], suggestion };
  }
  const domain = domainOf(email);
  const notes = [];
  let badge = "neutral";
  let label = "format ok";
  if (isDisposableDomain(domain)) {
    badge = "risky";
    label = "disposable";
    notes.push("Throwaway (disposable) email domain");
  }
  const role = classifyRole(email);
  if (role) {
    notes.push(`Role address (${role.prefix}@): a team inbox`);
    if (badge === "neutral") {
      badge = "risky";
      label = "role";
    }
  }
  if (suggestion) {
    notes.push(`Possible typo: did you mean ${suggestion}?`);
    if (badge === "neutral") {
      badge = "risky";
      label = "typo?";
    }
  }
  const kind = mailboxKind(domain);
  if (kind === "webmail") notes.push("Free webmail address");
  if (kind === "isp") notes.push("Internet provider address");
  return { email, badge, label, notes, suggestion };
}

/**
 * Format facts from libphonenumber's numbering-plan metadata. "valid format"
 * means the number fits its country's plan; it says nothing about whether the
 * number is in service.
 */
export function phoneInfo(raw, defaultCountry = "US") {
  const value = String(raw ?? "").trim();
  let parsed;
  try {
    parsed = parsePhoneNumberFromString(value, defaultCountry);
  } catch {
    parsed = undefined;
  }
  if (!parsed) return { phone: value, valid: false, e164: "", country: "", type: "", international: "" };
  const valid = parsed.isValid();
  return {
    phone: value,
    valid,
    e164: valid ? parsed.number : "",
    country: parsed.country ?? "",
    type: valid ? String(parsed.getType() ?? "").toLowerCase().replace(/_/g, " ") : "",
    international: valid ? parsed.formatInternational() : "",
  };
}

/* ------------------------------------------------------------- DNS */

async function doh(name, type, fetchImpl) {
  const url = `${DOH_URL}?${new URLSearchParams({ name, type })}`;
  const response = await fetchImpl(url, {
    headers: { accept: "application/dns-json" },
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`DNS ${response.status}`);
  const body = await response.json();
  // 0 = answer, 3 = name doesn't exist; anything else is a lookup failure.
  if (body.Status !== 0 && body.Status !== 3) throw new Error(`DNS status ${body.Status}`);
  const code = { MX: 15, TXT: 16 }[type];
  return (body.Answer ?? []).filter((a) => a.type === code).map((a) => String(a.data ?? ""));
}

/** TXT data arrives as one or more quoted strings; join them back into the record. */
export function txtValue(data) {
  const parts = data.match(/"((?:[^"\\]|\\.)*)"/g);
  return parts ? parts.map((p) => p.slice(1, -1).replace(/\\(.)/g, "$1")).join("") : data;
}

export function parseMx(answers) {
  return answers
    .map((data) => {
      const [priority, host] = data.trim().split(/\s+/);
      return { priority: Number(priority), host: String(host ?? "").replace(/\.$/, "").toLowerCase() };
    })
    .filter((mx) => Number.isFinite(mx.priority))
    .sort((a, b) => a.priority - b.priority);
}

/** The domain to look up for a page: hostname without www., lowercased. */
export function pageDomain(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (!host.includes(".") || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")) return null;
    return host;
  } catch {
    return null;
  }
}

/** Mail setup of a domain from public DNS: who receives its mail, and whether SPF and DMARC are published. */
export async function domainInfo(domain, fetchImpl = fetch) {
  const [mxAnswers, txtAnswers, dmarcAnswers] = await Promise.all([
    doh(domain, "MX", fetchImpl),
    doh(domain, "TXT", fetchImpl),
    doh(`_dmarc.${domain}`, "TXT", fetchImpl),
  ]);
  const mx = parseMx(mxAnswers);
  const nullMx = mx.length === 1 && (mx[0].host === "" || mx[0].host === ".");
  const front = !nullMx && mx[0] ? classifyMxHost(mx[0].host, domain) : null;
  const spf = txtAnswers.map(txtValue).find((t) => /^v=spf1(\s|$)/i.test(t)) ?? null;
  const dmarc = dmarcAnswers.map(txtValue).find((t) => /^v=DMARC1/i.test(t)) ?? null;
  const policy = dmarc?.match(/(?:^|;)\s*p\s*=\s*(none|quarantine|reject)/i)?.[1]?.toLowerCase() ?? null;
  return {
    domain,
    acceptsMail: mx.length > 0 && !nullMx,
    mxHost: nullMx ? "" : (mx[0]?.host ?? ""),
    provider: front?.name ?? null,
    providerRole: front?.role ?? null,
    spfHints: spfProviders(spf),
    spf: Boolean(spf),
    dmarc: Boolean(dmarc),
    dmarcPolicy: policy,
  };
}

/** Whether an email's domain has a mail server, for the single check. Null when DNS can't say. */
export async function domainAcceptsMail(domain, fetchImpl = fetch) {
  try {
    const mx = parseMx(await doh(domain, "MX", fetchImpl));
    if (mx.length === 1 && (mx[0].host === "" || mx[0].host === ".")) return false;
    return mx.length > 0;
  } catch {
    return null;
  }
}
