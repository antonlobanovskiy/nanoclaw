# Grocery Price Scraping Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable the grocery agent to scrape store websites for current prices, track them in SQLite, and include cost estimates in shopping list notifications.

**Architecture:** A new container skill teaches the agent per-store scraping playbooks using the existing `agent-browser` CLI. Price data goes into a SQLite DB in the grocery workspace. The grocery group's CLAUDE.md is updated to integrate price scraping into the shopping list generation protocol and add a daily staple check scheduled task. No changes to NanoClaw core code.

**Tech Stack:** `agent-browser` (Playwright/Chromium CLI, already installed), SQLite (via `sqlite3` CLI in container), Bash

---

### Task 1: Create the grocery-price-scraping skill

**Files:**
- Create: `container/skills/grocery-price-scraping/SKILL.md`

**Step 1: Create the skill file**

```markdown
---
name: grocery-price-scraping
description: Scrape grocery store websites for current prices. Use when generating shopping lists, checking prices, or running daily staple checks.
allowed-tools: Bash(agent-browser:*), Bash(sqlite3:*)
---

# Grocery Price Scraping

## Database Setup

On first use, create the SQLite database if it doesn't exist:

```bash
sqlite3 /workspace/extra/grocery-plan/prices.db <<'SQL'
CREATE TABLE IF NOT EXISTS prices (
    id INTEGER PRIMARY KEY,
    item TEXT NOT NULL,
    store TEXT NOT NULL,
    price REAL NOT NULL,
    unit TEXT,
    scraped_at TEXT NOT NULL DEFAULT (datetime('now')),
    notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_prices_item_store ON prices(item, store);
CREATE INDEX IF NOT EXISTS idx_prices_scraped_at ON prices(scraped_at);
SQL
```

## Auth State Files

Saved browser auth states are stored in `/workspace/extra/grocery-plan/.browser-state/`. Load before scraping:

```bash
agent-browser state load /workspace/extra/grocery-plan/.browser-state/<store>-auth.json
```

If state is expired or missing, re-authenticate (see per-store sections) and save:

```bash
mkdir -p /workspace/extra/grocery-plan/.browser-state
agent-browser state save /workspace/extra/grocery-plan/.browser-state/<store>-auth.json
```

## Recording a Price

After extracting a price, insert into SQLite:

```bash
sqlite3 /workspace/extra/grocery-plan/prices.db \
  "INSERT INTO prices (item, store, price, unit, notes) VALUES ('<item>', '<store>', <price>, '<unit>', '<notes>');"
```

## Querying Prices

Get latest price for an item across all stores:

```bash
sqlite3 -header -column /workspace/extra/grocery-plan/prices.db \
  "SELECT store, price, unit, notes, scraped_at FROM prices WHERE item = '<item>' ORDER BY scraped_at DESC LIMIT 5;"
```

Get rolling average for an item at a store (last 30 days):

```bash
sqlite3 /workspace/extra/grocery-plan/prices.db \
  "SELECT ROUND(AVG(price), 2) FROM prices WHERE item = '<item>' AND store = '<store>' AND scraped_at > datetime('now', '-30 days');"
```

## Per-Store Scraping Playbooks

### Costco (costco.com)

**Auth:** Load saved state. If expired, login:
1. `agent-browser open https://www.costco.com/`
2. Find and click "Sign In"
3. Fill email and password fields with provided credentials
4. Complete login, wait for dashboard
5. Save state to `costco-auth.json`

**Scraping an item:**
1. `agent-browser open https://www.costco.com/`
2. `agent-browser snapshot -i` — find the search box
3. `agent-browser fill @<search-ref> "<item name>"`
4. `agent-browser press Enter`
5. `agent-browser wait --load networkidle`
6. `agent-browser snapshot -i` — find product listing with price
7. Extract price using `agent-browser get text @<price-ref>`
8. Note the package size for unit price calculation (e.g., "5 dozen eggs" → price per egg)
9. Record in SQLite with unit = "per <unit>"

**Tips:**
- Costco shows member prices by default when logged in
- Search results page usually shows price without needing to click into product
- If a "warehouse only" badge appears, note in `notes` column
- Costco may show "Online Only" items — prefer warehouse items

### Publix (publix.com)

**Auth:** Load saved state. If expired, login:
1. `agent-browser open https://www.publix.com/`
2. Click sign in, enter account credentials
3. Set store location to Sarasota, FL if prompted
4. Save state to `publix-auth.json`

**Scraping an item:**
1. `agent-browser open https://www.publix.com/`
2. Find and use the search bar
3. `agent-browser fill @<search-ref> "<item name>"`
4. `agent-browser press Enter`
5. `agent-browser wait --load networkidle`
6. `agent-browser snapshot -i` — find product with price
7. Extract price with `agent-browser get text @<price-ref>`
8. Check for BOGO or sale tags — if present, note "BOGO" or "sale" in notes
9. Record in SQLite

**Weekly ad check:**
1. `agent-browser open https://www.publix.com/savings/weekly-ad`
2. `agent-browser wait --load networkidle`
3. `agent-browser snapshot -i` — browse deals
4. Look for items matching the shopping list or pantry staples
5. Record deal prices with "weekly ad" in notes

**Tips:**
- Publix deals reset every Wednesday — check Wednesday morning
- BOGO means buy-one-get-one-free: effective price is half the listed price
- Publix Club prices require being logged in

### Walmart (walmart.com)

**Auth:** No login required. Set store location on first visit:
1. `agent-browser open https://www.walmart.com/`
2. If location prompt appears, search for Sarasota FL Walmart
3. Save state to `walmart-auth.json` (just for location persistence)

**Scraping an item:**
1. `agent-browser open https://www.walmart.com/`
2. Find and use the search bar
3. `agent-browser fill @<search-ref> "<item name>"`
4. `agent-browser press Enter`
5. `agent-browser wait --load networkidle`
6. `agent-browser snapshot -i` — find product listing
7. Extract price with `agent-browser get text @<price-ref>`
8. Walmart often shows unit price (e.g., "$0.12/oz") — capture both
9. Record in SQLite with unit price if available

**Tips:**
- Walmart shows "Great Value" store brand prominently — good for budget items
- Look for "Rollback" tags = temporary price reduction
- "Pickup" availability tells you if the item is in stock locally

### Detwiler's (via Instacart)

**Auth:** Load saved state. If expired, login via Google:
1. `agent-browser open https://www.instacart.com/`
2. Click sign in, choose "Continue with Google"
3. Complete Google OAuth flow with provided credentials
4. Save state to `detwilers-auth.json`

**Scraping an item:**
1. `agent-browser open https://www.instacart.com/store/detwilers-farm-market/search/<item>`
2. Or: navigate to Instacart, search for Detwiler's Farm Market, then search item
3. `agent-browser wait --load networkidle`
4. `agent-browser snapshot -i` — find product with price
5. Extract price with `agent-browser get text @<price-ref>`
6. Record in SQLite with notes = "instacart" (prices may differ from in-store)

**Tips:**
- Instacart prices are often 10-15% higher than in-store
- Note this in the shopping list estimate ("Detwiler's prices are Instacart estimates")
- If Detwiler's is unavailable on Instacart, skip and note in output

### Trader Joe's (traderjoes.com)

**Auth:** None required.

**Scraping an item:**
1. `agent-browser open https://www.traderjoes.com/home/search?q=<item>&section=products`
2. `agent-browser wait --load networkidle`
3. `agent-browser snapshot -i` — find product with price
4. Extract price with `agent-browser get text @<price-ref>`
5. Record in SQLite

**Tips:**
- TJ's prices rarely change — scraping weekly or monthly is sufficient
- TJ's website is simple and usually reliable
- Product names are often unique (e.g., "Everything But The Bagel Seasoning")

## Error Handling

- **Site down/timeout:** Wait 30s max per item (`agent-browser wait 30000`). If still no result, skip and note "unavailable" in output.
- **Item not found:** Try alternate search terms (e.g., "chicken breast" → "boneless skinless chicken"). If still not found, skip and note "not found".
- **Auth expired:** Attempt re-login. If fails, skip store and alert user: "Could not authenticate with <store> — please check credentials."
- **CAPTCHA/bot detection:** Skip store and alert user. Add `agent-browser wait 2000` delays between items to reduce detection risk.
- **Price unclear:** If multiple prices shown (regular vs sale), record the lower effective price and note context.

## Close Browser When Done

Always close the browser after a scraping session to free resources:

```bash
agent-browser close
```
```

**Step 2: Verify the skill file has correct frontmatter**

Run: `head -5 container/skills/grocery-price-scraping/SKILL.md`
Expected: Shows the `---` delimited frontmatter with name, description, allowed-tools.

**Step 3: Commit**

```bash
git add container/skills/grocery-price-scraping/SKILL.md
git commit -m "feat: add grocery-price-scraping skill"
```

---

### Task 2: Update grocery CLAUDE.md — extend Shopping Plan Generation with price scraping

**Files:**
- Modify: `groups/grocery/CLAUDE.md:148-162` (Shopping Plan Generation steps 8-12)

The current step 8 generates a store-by-store list. We insert price scraping after that and update the Discord notification format.

**Step 1: Replace steps 8-12 with price-aware version**

Replace the Shopping Plan Generation steps 8 through 12 in `groups/grocery/CLAUDE.md` with:

```
8. Generate a store-by-store list. Use the store strategy (Detwiler's for produce, Publix for proteins/deli/BOGO, Walmart for pantry fill-ins).
9. **Scrape current prices** using the `grocery-price-scraping` skill:
   - For each store's item list, open the store website and look up current prices
   - Record all prices in the SQLite database at `/workspace/extra/grocery-plan/prices.db`
   - Calculate: per-item cost (price x quantity), per-store subtotal, trip total
   - If any items can't be priced (site down, not found), note "price unavailable" and exclude from totals
   - If trip total would exceed remaining monthly budget, flag it and suggest items to defer or substitute
10. Update the appropriate JSON file:
   - Week A: `/workspace/extra/grocery-plan/shopping-lists/week-a-items.json`
   - Week B: `/workspace/extra/grocery-plan/shopping-lists/week-b-items.json`
   - JSON format: `{ "item": "...", "store": "Publix|Detwiler's|Walmart", "category": "Protein|Produce|Dairy|Bakery|Deli|Pantry|Frozen|Snacks|Breakfast", "price": 0.00, "unit": "each|per lb|..." }`
11. Run: `cd /workspace/extra/grocery-plan && node sync-to-notion.js shopping-lists/week-a-items.json` (or week-b)
12. Commit: `cd /workspace/extra/grocery-plan && git add -A && git commit -m "shopping-list: generate week [A/B] list $(date +%Y-%m-%d)"`
13. Send Discord summary with cost breakdown:
   ```
   Shopping list is ready in Notion!

   🏪 Publix (X items): ~$XX
     • Item 1 — $X.XX/lb ($X.XX) [BOGO if applicable]
     • Item 2 — $X.XX ea ($X.XX)
     • ...

   🌿 Detwiler's (X items): ~$XX [Instacart estimates]
     • Item 1 — $X.XX
     • ...

   🛒 Walmart (X items): ~$XX
     • Item 1 — $X.XX ea ($X.XX)
     • ...

   💰 Trip total: ~$XXX
   📊 Month so far: $XXX + $XXX = $XXX / $900 ($XXX remaining)
   ```
```

**Step 2: Verify the edit reads correctly in context**

Run: Read `groups/grocery/CLAUDE.md` lines 136-175 to verify the updated Shopping Plan Generation section.

**Step 3: Commit**

```bash
git add groups/grocery/CLAUDE.md
git commit -m "feat(grocery): add price scraping to shopping list generation"
```

---

### Task 3: Update grocery CLAUDE.md — add daily staple check scheduled task

**Files:**
- Modify: `groups/grocery/CLAUDE.md` (append new section after Budget Summary, before end of file)

**Step 1: Add the scheduled task section**

Append after the Budget Summary section (after the closing ``` of the budget example):

```
### Daily Staple Price Check (Scheduled Task)

**Trigger:** Runs daily at 8:00 AM via scheduled task.

**Process:**

1. Read `pantry-staples.md` for the list of staple items to track.
2. For each staple item, scrape the current price at its primary store (use store-strategy.md to determine which store).
3. Record all prices in the SQLite database at `/workspace/extra/grocery-plan/prices.db`.
4. Compare each price against its 30-day rolling average:
   ```bash
   sqlite3 /workspace/extra/grocery-plan/prices.db \
     "SELECT ROUND(AVG(price), 2) FROM prices WHERE item = '<item>' AND store = '<store>' AND scraped_at > datetime('now', '-30 days');"
   ```
5. If any item's price dropped >15% below its rolling average, or has a BOGO/sale tag, send a Discord alert:
   ```
   🏷️ Price alert!
     • Chicken thighs at Publix: $2.49/lb (avg $4.19) — BOGO this week
     • Eggs at Walmart: $3.28/5doz (down from $4.12)
   ```
6. If no notable deals found, do NOT send a message (silent check).
7. Close the browser when done: `agent-browser close`

### Ad-Hoc Price Lookup

When Anton asks about a specific item's price (e.g., "how much is salmon at Costco?"):

1. Scrape the current price using the `grocery-price-scraping` skill.
2. Check the price history from SQLite.
3. Reply with current price, recent trend, and comparison across stores if relevant:
   ```
   Salmon at Costco: $8.99/lb (wild-caught Atlantic, 3lb pack = $26.97)
   30-day avg: $9.49/lb — current price is 5% below average
   Publix: $11.99/lb (no sale this week)
   Walmart: $9.47/lb
   ```
```

**Step 2: Verify the new sections appear correctly**

Run: Read the end of `groups/grocery/CLAUDE.md` to verify.

**Step 3: Commit**

```bash
git add groups/grocery/CLAUDE.md
git commit -m "feat(grocery): add daily staple price check and ad-hoc lookup protocols"
```

---

### Task 4: Add the scheduled task to the grocery group

**Files:**
- This requires sending a message to register the scheduled task via the NanoClaw task scheduler, OR adding it to any task config file.

**Step 1: Determine how scheduled tasks are registered**

Read `src/task-scheduler.ts` to understand how tasks are stored and registered. Check if there's a config file or if tasks are registered via IPC.

**Step 2: Register the daily staple check task**

Based on how the scheduler works, register a task that:
- Runs daily at 8:00 AM Eastern
- Group: `grocery`
- Prompt: `"Run the daily staple price check. Read pantry-staples.md, scrape current prices for key staples across all stores, record in SQLite, and alert me if any notable deals are found."`

The exact mechanism depends on what Task 4 Step 1 reveals (could be a DB entry, config file, or IPC message).

**Step 3: Verify the task is registered**

Check the task list in the database or config to confirm the daily task appears.

**Step 4: Commit if any files changed**

```bash
git add -A
git commit -m "feat(grocery): register daily staple price check scheduled task"
```

---

### Task 5: Add .browser-state to .gitignore

**Files:**
- Check if there's a `.gitignore` in the grocery-plan workspace
- If the grocery-plan repo is separate, add `.browser-state/` to its `.gitignore`
- Also add `prices.db` since it's a binary that shouldn't be in git

**Step 1: Add gitignore entries**

In the grocery-plan workspace's `.gitignore` (create if needed):

```
.browser-state/
prices.db
prices.db-journal
prices.db-wal
```

**Step 2: Commit**

```bash
cd /workspace/extra/grocery-plan  # (or wherever the grocery-plan repo is on host)
git add .gitignore
git commit -m "chore: gitignore browser state and price database"
```

---

### Task 6: Initial auth setup for all stores

This task is manual/interactive — the agent needs Anton's credentials to log in and save browser state for each store.

**Step 1: Trigger initial auth for each store**

Send a message to the grocery agent (via Discord/WhatsApp):
> "Set up browser authentication for grocery price scraping. Log in to each store one at a time — I'll provide credentials when you need them. Start with Costco."

The agent will use `agent-browser` to:
1. Open costco.com → login with provided credentials → save state
2. Open publix.com → login → save state
3. Open walmart.com → set location → save state
4. Open instacart.com → Google auth → save state
5. Trader Joe's → no auth needed

**Step 2: Verify saved states**

After auth, check that state files exist:
```bash
ls -la /workspace/extra/grocery-plan/.browser-state/
```

Expected: `costco-auth.json`, `publix-auth.json`, `walmart-auth.json`, `detwilers-auth.json`

---

### Task 7: End-to-end test

**Step 1: Test ad-hoc lookup**

Send a message to the grocery agent:
> "How much are eggs at Costco and Walmart right now?"

Verify the agent:
- Opens each store's website
- Finds and extracts the price
- Records it in SQLite
- Responds with prices and comparison

**Step 2: Test shopping list generation with prices**

Send a message to the grocery agent:
> "Generate this week's shopping list"

Verify the Discord notification includes:
- Per-item prices
- Per-store subtotals
- Trip total
- Month-to-date budget status

**Step 3: Verify SQLite data**

```bash
sqlite3 -header -column /workspace/extra/grocery-plan/prices.db \
  "SELECT * FROM prices ORDER BY scraped_at DESC LIMIT 20;"
```

Verify prices were recorded correctly.
