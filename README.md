<h1 align="center">AutoBuy</h1>

<p align="center">
  <strong>A Discord store that takes payment, delivers the item, and keeps the books.</strong><br>
  Sell codes, links, accounts, and other digital products without making buyers leave your server.
</p>

<p align="center">
  <a href="#get-started">Get started</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#commands">Commands</a> ·
  <a href="tutorial.txt">Setup tutorial</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white" alt="Node.js 18 or newer">
  <img src="https://img.shields.io/badge/Discord.js-14-5865F2?logo=discord&logoColor=white" alt="Discord.js 14">
  <img src="https://img.shields.io/badge/Payments-GCash-007DFF" alt="GCash payments">
  <img src="https://img.shields.io/badge/License-ISC-blue" alt="ISC license">
</p>

## What it is

AutoBuy turns a Discord server into a self-service digital shop.

A buyer opens `/store`, chooses a product, pays from their balance, and receives the item in a DM. Staff get the controls they actually need: stock management, refunds, receipt review, sales notifications, and analytics. The bot runs with a local MongoDB by default, so the store can stay on your machine instead of depending on a hosted database.

## How it works

### Buyers

1. **Browse** products in `/store` or `/stock list`.
2. **Top up** through the GCash card shown by `/topup`.
3. **Submit** the receipt screenshot and reference number in the form.
4. **Receive** the purchased item in a DM with an invoice.

If a buyer's DMs are closed, the order is shown in the channel too. `/orderid` can bring the delivery back later.

### Receipt checking

Receipt OCR runs on the same machine as the bot. Matching GCash and InstaPay receipts can be credited automatically when the amount, recipient, date, and reference number all match. Anything uncertain goes to the staff approval channel with the reason it needs review.

Reused reference numbers and screenshots are rejected from the bot's own records. Auto-approved top-ups can be undone by staff if a payment later needs investigation.

### Operators

The store stays useful after launch:

- Live store and stock embeds refresh when products change.
- Low-stock and sold-out alerts go to the staff log.
- `/analytics` shows revenue, costs, profit, expenses, customers, and CSV export.
- `/refund` supports order or product refunds without restocking used codes by default.
- `/backup` exports server data for private safekeeping.

## Product types

Stock is one item per line, so a product can be:

- License or access codes
- Serial numbers
- Links
- `email:password` accounts
- Any other digital delivery text

Products can also have a description, custom DM message, and link buttons.

## Get started

You need Windows 10/11, Node.js 18.17 or newer, a Discord application, and a server where you can install the bot.

### Windows

1. Download the repository.
2. Double-click **`start.bat`**.
3. On first run, open the generated `.env` file and fill in `BOT_TOKEN`, `OWNER_IDS`, and your GCash details.
4. Run **`start.bat`** again.

The launcher installs dependencies, starts the bundled local database, and starts the bot. It also checks for the local receipt-reader package on older installations.

### Manual start

```bash
npm install
npm start
```

The local database is stored in `data/db/` and is not tracked by Git.

To use your own MongoDB instead:

```bash
npm run start:remote-db
```

Set `MONGODB_URI` in your private `.env` first.

For the full Discord setup, permissions, GCash configuration, and deployment notes, read [`tutorial.txt`](tutorial.txt).

## First commands

After inviting the bot, run these as the owner:

```text
/setlogchannel #staff-logs
/settings approval-channel #topup-review
/settings sales-channel #sales
/addproduct
/setupstore
```

If you use DM-everyone announcements, enable **Server Members Intent** in the Discord Developer Portal. Keep mass announcements rare and follow Discord's rules.

## Commands

### Everyone

| Command | Purpose |
|---|---|
| `/help` | Show the command guide |
| `/store` | Browse and buy products |
| `/stock list` | List available products |
| `/stock buy` | Buy by product code |
| `/topup` | Start a GCash top-up |
| `/balance` | Check a balance |
| `/user` | View an account card |
| `/gift` | Gift balance with a note |
| `/redeem` | Redeem a coupon |
| `/history` | View purchase history |
| `/orderid` | Retrieve a delivery |
| `/leaderboard` | Show the top balances |
| `/recoverbalance use` | Move a balance with a recovery key |

### Staff

| Command | Purpose |
|---|---|
| `/addproduct` · `/updateproduct` · `/removeproduct` | Manage products |
| `/updatestocknew` | Change price or add items |
| `/changestock` · `/editstock` | Replace stock |
| `/editdelivery` | Change delivery text and buttons |
| `/setcost` | Record item cost for profit reporting |
| `/expense` | Add, list, or remove expenses |
| `/setupstore` · `/createshop` · `/livestock` | Publish store embeds |
| `/category` | Group products for the store and stock board |
| `/setlogchannel` · `/setleaderboard` | Configure staff logs and leaderboard display |
| `/refund` | Refund an order or product |
| `/analytics` | View sales and profit analytics |
| `/resetanalytics` | Reset analytics data |
| `/addbalance` | Add customer balance |
| `/createcoupon` · `/coupons` | Manage coupons |
| `/embed` · `/stickmessage` | Manage custom embeds and sticky messages |

### Owner

| Command | Purpose |
|---|---|
| `/announcement send` | Preview and post an announcement or DM campaign |
| `/announcement addowner` · `removeowner` | Manage bot admins |
| `/announcement owners` | List owners and admins |
| `/settings view` | View server settings |
| `/settings store` | Open or close buying |
| `/settings auto-approve` | Configure receipt auto-approval |
| `/settings reviews-channel` | Enable or disable buyer reviews |
| `/settings customer-role` | Assign a role after purchase |
| `/removebalance` | Remove balance |
| `/backup` | Export server data privately |

## Configuration

Copy `.env.example` to `.env`. The important settings are:

| Setting | Used for |
|---|---|
| `BOT_TOKEN` | Discord authentication |
| `OWNER_IDS` | Main bot owners |
| `STAFF_ROLE_IDS` | Staff role access |
| `GCASH_NUMBER` | Payment recipient shown to buyers |
| `GCASH_NAME` | Payment recipient name |
| `GCASH_QR_URL` | Optional GCash QR image |
| `GCASH_NOTE` | Extra payment instructions |
| `BRAND` and `CURRENCY` | Store branding |
| `MONGODB_URI` | External database mode |

Never commit `.env`. If a Discord token is exposed, reset it immediately in the Developer Portal.

## Where the private data lives

| Path | Contents |
|---|---|
| `data/db/` | Local MongoDB data |
| `data/store/` | Balances, top-ups, settings, and logs in JSON |
| `data/stock/` | Items for sale |
| `backups/` | Private exports from `/backup` |

These paths are ignored by Git on purpose. The repository only tracks `data/.gitkeep` so a fresh checkout has the expected directory.

## Project layout

```text
src/                 Bot commands, events, storage, and utilities
vendor/tessdata/     Local OCR language data
start.bat            Windows launcher
start-local.js       Local MongoDB launcher
.env.example         Safe configuration template
tutorial.txt         Detailed setup and deployment guide
```

## License

ISC. See [`LICENSE`](LICENSE).

AutoBuy is an independent Discord bot and is not affiliated with Discord, GCash, or MongoDB.
