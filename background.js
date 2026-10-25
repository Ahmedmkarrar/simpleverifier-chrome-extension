import { PENDING_STORAGE } from "./lib/config.js";
import { track } from "./lib/telemetry.js";

const MENU_ID = "sv-verify-selection";
const EMAIL = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.contextMenus.create({ id: MENU_ID, title: "Verify “%s” with SimpleVerifier", contexts: ["selection"] });
  if (reason === "install") track("install");
});

/**
 * Right-click on selected text: Chrome hands over only the selected text, the
 * page itself is not read. The popup picks the address up from session
 * storage (cleared when the browser closes) and checks it.
 */
chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== MENU_ID) return;
  const match = (info.selectionText ?? "").match(EMAIL);
  const value = (match ? match[0] : (info.selectionText ?? "")).trim().slice(0, 254);
  if (!value) return;
  await chrome.storage.session.set({ [PENDING_STORAGE]: value });
  try {
    await chrome.action.openPopup();
  } catch {
    await chrome.action.setBadgeBackgroundColor({ color: "#3b82f6" });
    await chrome.action.setBadgeText({ text: "1" });
  }
});
