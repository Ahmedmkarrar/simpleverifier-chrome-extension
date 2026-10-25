/**
 * Anonymous usage events to PostHog. A random install id (not linked to your
 * account or email), the event name, the extension version and counts only:
 * never addresses, numbers, page URLs or domains. Off with one click in the
 * popup footer; nothing is sent while it is off.
 */
import { POSTHOG_KEY, POSTHOG_URL } from "./config.js";

const ID_KEY = "svInstallId";
const OPT_OUT_KEY = "svTelemetryOff";

export async function telemetryEnabled() {
  const stored = await chrome.storage.local.get(OPT_OUT_KEY);
  return stored[OPT_OUT_KEY] !== true;
}

export function setTelemetry(enabled) {
  return chrome.storage.local.set({ [OPT_OUT_KEY]: !enabled });
}

async function installId() {
  const stored = await chrome.storage.local.get(ID_KEY);
  if (typeof stored[ID_KEY] === "string") return stored[ID_KEY];
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [ID_KEY]: id });
  return id;
}

/** Fire-and-forget; analytics never blocks or breaks the popup. */
export async function track(event, properties = {}) {
  try {
    if (!POSTHOG_KEY || !(await telemetryEnabled())) return;
    await fetch(POSTHOG_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      body: JSON.stringify({
        api_key: POSTHOG_KEY,
        event: `extension_${event}`,
        distinct_id: await installId(),
        properties: {
          ...properties,
          source: "chrome_extension",
          extension_version: chrome.runtime.getManifest().version,
          $process_person_profile: false,
          $geoip_disable: true,
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // ignore
  }
}
