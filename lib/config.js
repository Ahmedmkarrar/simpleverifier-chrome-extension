/** Shared constants. No chrome.* access, so tests can import it. */

export const SITE = "https://simpleverifier.com";
export const DOH_URL = "https://cloudflare-dns.com/dns-query";
export const POSTHOG_URL = "https://us.i.posthog.com/i/v0/e/";
/** The site's public PostHog project key (it is in every page's HTML too). */
export const POSTHOG_KEY = ""; // set in the store build; empty = no events are sent

/** Must match EXTENSION_FREE_LIVE_CHECKS in src/lib/extension.ts; the server is the source of truth. */
export const FREE_LIVE_CHECKS = 50;
/** Successful uses before the one-time "Enjoying it?" line may appear. */
export const RATING_AFTER_USES = 5;

const UTM = "utm_source=chrome-extension&utm_medium=extension";

export function siteUrl(path, campaign) {
  const joiner = path.includes("?") ? "&" : "?";
  return `${SITE}${path}${joiner}${UTM}&utm_campaign=${encodeURIComponent(campaign)}`;
}

export const SIGN_IN_URL = `${SITE}/login?callbackUrl=${encodeURIComponent("/extension?connected=1")}`;
export const PRIVACY_URL = `${SITE}/extension/privacy`;

/** chrome.storage.session key: an address picked from the right-click menu, waiting for the popup. */
export const PENDING_STORAGE = "svPendingCheck";
export const API_KEYS_URL = `${SITE}/api-keys?utm_source=chrome-extension&utm_medium=extension&utm_campaign=api_key`;
