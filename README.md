# X Nuke DMs

Chrome extension that deletes your own X direct-message conversations in bulk. Removal matches X's **Delete conversation**: the thread leaves your inbox, and the other person keeps their copy. It does not unsend messages.

Nothing runs until you scan, choose conversations, type `DELETE`, and click the button. The signed-in X session in this browser is the only credential. Message contents are not decrypted, displayed, or saved. The scan keeps conversation ids, names, and dates.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this folder.
4. Open [x.com](https://x.com) while signed in. Messages can stay closed; the scan uses the session on that tab.
5. Open the extension popup and choose **Scan inbox**.

Keep that x.com tab open until the delete finishes. Closing it stops the run. Use **Stop** to halt a scan or delete. The pause between deletes defaults to 1.2 seconds so a large inbox does not immediately hit X's rate limit. If X rate-limits the tab, the run waits and retries, then stops after repeated limits.

## What you can filter

- **Primary**, **Requests**, **Hidden requests**, and **Groups**. Legacy inboxes use X's own trusted / request / low-quality split. Groups are separate.
- **At least N days old.** Conversations with no date are left out of an age filter so a missing timestamp cannot be treated as ancient.
- **Name.** Matches the other person's name or the group title. It does not search message text.

The list shows the first 300 matches. **Select all** still includes every match, including ones below the fold. The delete button counts only conversations that are both checked and inside the current filters. A conversation is removed from the list only after X confirms the delete. An HTTP success from the legacy endpoint does not count for an X Chat thread.

## Debug

The popup keeps the last 80 scan and delete lines. Failures are red. Each line has the endpoint, HTTP status, and a short response summary with message payloads redacted. Clear wipes that log. Reload the extension on `chrome://extensions` after updating this folder, then reload the x.com tab.

## Inboxes

X still has two conversation systems:

- **Legacy DMs** are listed through `dm/inbox_initial_state` and older pages, then removed with `dm/conversation/…/delete.json`.
- **X Chat** (the encrypted inbox) is listed with the initial chat-page query. Older pages, and deletes, use the query documents this tab can read from X's own scripts. Delete one conversation by hand in Messages if a later X deploy hides that query; the extension picks up the query X just sent and does not reuse the signature from that request.

If X Chat requires a device signature, that delete stops and the error is shown. The extension does not extract keys or sign events. A one-to-one conversation that still exists in the legacy inbox is removed there instead.

## What it does not do

- It does not delete the other person's copy, and it does not delete for everyone.
- It does not run on its own, export the inbox, or change who you follow.
- It only works while an x.com tab for the signed-in account is open.
- X changes these endpoints. A failed scan tells you to reload x.com; the legacy delete path is the one the popup can finish without a new query id.

## Tests

```bash
node test/inbox.test.js
```

## Layout

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V3 extension config |
| `inbox.js` | Inbox parsing, labels, and filters |
| `xchat.js` | X Chat initial-inbox query |
| `inject.js` | Page-world scan and delete runner |
| `content.js` | Bridges the popup to the page |
| `popup.html` | Scan, filter, and confirm controls |
| `background.js` | Toolbar badge while deleting |
| `test/inbox.test.js` | Parser and filter tests |

## License

[CC0 1.0 Universal](LICENSE). The work is dedicated to the public domain. See `LICENSE`.
