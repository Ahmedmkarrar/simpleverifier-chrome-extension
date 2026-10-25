# SimpleVerifier: Email Finder & Verifier (Chrome extension)

Find the email addresses on any page, or right-click one to verify it.

- **Free, in your browser:** syntax, typo suggestions ("did you mean gmail.com?"), disposable domains and role addresses like `sales@`. These checks run locally.
- **Live mailbox checks:** sign in to your SimpleVerifier account, or paste an API key, to run the live SMTP check on simpleverifier.com.

Manifest V3. Permissions: `activeTab`, `contextMenus`, `scripting`, `storage`, and host access to `simpleverifier.com` only. Privacy policy: https://simpleverifier.com/extension/privacy

## Load it unpacked

1. Clone this repo.
2. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and pick the folder.

Anonymous usage events (counts only, never addresses or URLs) are off in this source build: `POSTHOG_KEY` in `lib/config.js` is empty. `lib/vendor.js` holds the bundled disposable-domain list used for the in-browser check.

More: https://simpleverifier.com/extension

## License

MIT
