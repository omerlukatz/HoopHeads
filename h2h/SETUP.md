# Connect H2H to a Google Sheet

This takes about 10 minutes, and you only do it once. After that, everyone (you, your friends, and
their friends) creates their own account in the app. Nobody else needs to touch the Sheet.

Until you finish these steps, the app runs in **demo mode**:
- Sample accounts: alex / 1111, sam / 2222, jordan / 3333, riley / 4444.
- Everything is stored only in your browser.

## 1. Create the Sheet

1. Go to **sheets.new** (signed in to your Google account). Rename the new spreadsheet **H2H**.

## 2. Add the script

2. In the Sheet's menu, choose **Extensions → Apps Script**.
3. Delete everything in the editor, paste in **all** of `apps-script/Code.gs`, and click **Save** (💾).
   Name the project **H2H API** if asked.

## 3. Create the tabs

4. In the function dropdown next to **Run**, pick **setupSheet**, then click **Run**.
5. The first time, Google asks for permission:
   - Click **Review permissions** and choose your account.
   - At "Google hasn't verified this app", click **Advanced → Go to H2H API (unsafe) → Allow**.
     It's your own script, so this warning is expected.
6. The Sheet now has three tabs:
   - **Users**: `id, username, display_name, pin_hash, color, initial, created_at`
   - **Friendships**: `id, user_a, user_b, created_at`
   - **Games**: `id, date, player1_id, player2_id, player1_score, player2_score, player1_team, player2_team, overtime, note, created_by, created_at, updated_at, deleted`

## 4. Deploy it as a web app

7. Click **Deploy → New deployment**, then the gear ⚙️ next to "Select type", then **Web app**.
8. Fill in:
   - **Execute as:** **Me**
   - **Who has access:** **Anyone**. The app calls the script without a Google sign-in; accounts and
     PINs protect the data.
9. Click **Deploy** and copy the **Web app URL**, which ends in `/exec`.

## 5. Point the app at it

10. Paste the URL into `config.js`:
    ```js
    APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfy…/exec',
    ```
11. Re-deploy the site (see README.md) and open it.
12. Tap **Create Account**, choose your name, a username and a 4-digit PIN.
13. Your friend does the same on their phone.
14. Go to **Friends**, search for their name or username, and tap **Add**. Your head-to-head tracker
    opens right away, and you'll appear in their friends list too.

## Whenever you edit the script: redeploy a new version

Saving `Code.gs` does **not** update the live app. After any change:

**Deploy → Manage deployments →** your deployment **→ ✏️ Edit → Version: New version → Deploy.**

The URL stays the same.

## Handy one-off functions

Pick one in the function dropdown and click **Run**:

| Function | What it does |
|---|---|
| `resetPin` | Forgotten PIN: fill in `USERNAME` and `NEW_PIN` at the top of the function, run it, then clear both and save. It also signs that person out everywhere. |
| `clearLockouts` | Unlocks any username right away after 5 wrong PINs, instead of waiting 5 minutes. |
| `signOutEverywhere` | Ends every session on every device. |

## Troubleshooting

- **"The Sheet returned an unexpected response"**: *Who has access* isn't **Anyone**, or you pasted
  the editor URL instead of the `/exec` URL.
- **"The Users tab is missing"**: run `setupSheet`.
- **Changes to the script have no effect**: redeploy a new version (see above).
- **Editing the Sheet by hand**: that's fine, but to remove a game set `deleted` to `TRUE` rather than
  deleting the row. Deletes in the app work the same way, so nothing is ever lost.

## An honest note on security

This is a lightweight lock for friends, not bank-grade security.

**What it does:**
- PINs are never stored in plain text; only salted SHA-256 hashes are stored.
- The server checks every read and write.
- Wrong guesses are rate-limited per username.
- You can only log or change games between yourself and your friends.

**What it doesn't protect against:**
- Anyone with the link can create an account and search users by name.
- Adding a friend is instant, so anyone who finds you can add you and log games against you.
- A 4-digit PIN has only 10,000 combinations. The lockout slows guessing but doesn't make it impossible.
- Anyone with edit access to the Sheet can see and change everything.
- A signed-in phone stays signed in for up to 180 days. Use **Sign Out**, or `signOutEverywhere`, if a
  phone is lost.

Pick a PIN you don't use anywhere else, and a different one from your friends'.
