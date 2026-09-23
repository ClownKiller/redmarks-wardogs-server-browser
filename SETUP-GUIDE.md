# Squad presence: setup guide

Squad presence lets your mates see which server you're heading to. It's **off until you turn it on**, and nothing is shared unless you press **Join**.

There are two ways to share. You can use either, or both.

| | Discord announcements | Web API on your own site |
| --- | --- | --- |
| Needs hosting | No | Yes (PHP) |
| Setup time | About 2 minutes | About 10 minutes |
| Squad list inside the app | No | Yes |
| How mates see it | Posts in a Discord channel | The Squad tab |

**What gets shared, either way:** the name you choose, the server you pressed Join on (its name, region and join code), and the time. Nothing else. The app can never tell which server you're actually in, because that would mean reading the game, so everything says "heading to".

---

## Option 1: Discord announcements

1. In Discord, make a **private channel** for your crew, so only invited people can see the posts.
2. Open **Server Settings → Integrations → Webhooks**.
3. Click **New Webhook**, choose that channel, then **Copy Webhook URL**.
4. In the app, open **Settings** (the gear icon), scroll to **Squad**.
5. Type **your name in the squad**, paste the link into **Discord webhook link**, and tick **Discord announcements**.
6. Press **Join** on any server to test. A line appears in your channel.

**Keep the webhook link private.** Anyone who has it can post in that channel. If it leaks, delete the webhook in Discord and make a new one; the old link stops working immediately.

Discord limits a webhook to 30 posts a minute. The app spaces its posts out and won't repeat the same server within five minutes, so you won't hit that.

---

## Option 2: Web API on your own website

You need web hosting that runs **PHP 7.4 or newer** and has **https**. No database is needed.

### On your website

1. Find the **webapi** folder in the project files (the same zip as the app's code).
2. Open **config.php** in Notepad.
3. Replace `change-me-to-a-long-random-key` with a long random key of your own, at least 12 characters. Save.
4. Upload the whole folder to your site, for example into a folder called `squad`, so you end up with `yoursite.com/squad/squad.php`.
5. Open **yoursite.com/squad/check.php** in your browser. It checks everything and tells you what to fix. When it's all OK it shows the exact address to paste into the app.
6. Optional: delete `check.php` afterwards.

### In the app

1. Open **Settings → Squad**.
2. Type **your name in the squad**.
3. Paste the address from check.php into **Address of squad.php**.
4. Paste the **same key** you put in config.php into **Squad key**.
5. Click **Create squad**. This fills in a squad code.
6. Tick **Web API**. The Squad tab starts working.

### Adding your mates

1. Click **Copy invite line**.
2. Send it to each mate **privately** (a Discord DM or a text). It contains your squad key, so don't post it publicly.
3. They open **Settings → Squad**, paste it into **Invite line from a mate**, click **Use invite**, type their name, and they're in.

No accounts, no signup, no website visit for them.

### Settings you can change in config.php

| Setting | Default | What it does |
| --- | --- | --- |
| `$SQUAD_KEY` | *(example)* | The shared key. Must match what everyone has in the app. |
| `$MAX_MEMBERS` | 30 | How many people can be checked in at once. |
| `$EXPIRE_MINUTES` | 180 | Entries older than this are forgotten. |
| `$BLOCKED_NAMES` | empty | Names that can't post, for removing someone quickly. |

### Removing someone

Change `$SQUAD_KEY` in config.php and send everyone a fresh invite line. The old key stops working straight away. For a quick block, add their name to `$BLOCKED_NAMES`.

### Files

| File | What it is |
| --- | --- |
| `config.php` | The only file you edit |
| `squad.php` | The API the app talks to |
| `check.php` | Setup check page, safe to delete afterwards |
| `squad-data.php` | Created automatically. Holds current presence, and can't be read through a browser |

---

## Troubleshooting

- **"The squad API address must start with https://"** — your site needs SSL. Most hosts offer it free.
- **"This squad API has not been set up yet"** — the key in config.php is still the example one.
- **"Wrong squad key"** — the key in the app and the key in config.php don't match exactly.
- **"This folder can be written to: PROBLEM"** — set the folder's permissions to 755 in your host's file manager.
- **Nothing appears in the Squad tab** — names only appear after someone presses **Join**, and disappear again after three hours.
