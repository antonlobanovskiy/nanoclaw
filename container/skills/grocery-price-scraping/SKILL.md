---
name: grocery-price-scraping
description: Scrape grocery store websites for current prices. Use when generating shopping lists, checking prices, or running daily staple checks.
allowed-tools: Bash(agent-browser:*), Bash(sqlite3:*)
---

# Grocery Price Scraping

## Database Setup

On first use, create the SQLite database if it doesn't exist:

```bash
sqlite3 /workspace/extra/grocery-plan/grocery.db <<'SQL'
CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY,
    item TEXT NOT NULL,
    category TEXT NOT NULL,
    quantity TEXT,
    status TEXT DEFAULT 'ok',
    last_restocked TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shopping_list (
    id INTEGER PRIMARY KEY,
    item TEXT NOT NULL,
    store TEXT NOT NULL,
    category TEXT NOT NULL,
    quantity TEXT,
    price REAL,
    unit_price REAL,
    unit TEXT,
    checked INTEGER DEFAULT 0,
    week TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    notes TEXT
);

CREATE TABLE IF NOT EXISTS prices (
    id INTEGER PRIMARY KEY,
    item TEXT NOT NULL,
    store TEXT NOT NULL,
    price REAL NOT NULL,
    unit TEXT,
    scraped_at TEXT NOT NULL DEFAULT (datetime('now')),
    notes TEXT
);

CREATE TABLE IF NOT EXISTS budget (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    store TEXT NOT NULL,
    total REAL NOT NULL,
    items_count INTEGER,
    notes TEXT,
    receipt_image TEXT
);

CREATE INDEX IF NOT EXISTS idx_inventory_status ON inventory(status);
CREATE INDEX IF NOT EXISTS idx_inventory_item ON inventory(item);
CREATE INDEX IF NOT EXISTS idx_shopping_list_week ON shopping_list(week);
CREATE INDEX IF NOT EXISTS idx_prices_item_store ON prices(item, store);
CREATE INDEX IF NOT EXISTS idx_prices_scraped_at ON prices(scraped_at);
CREATE INDEX IF NOT EXISTS idx_budget_date ON budget(date);
CREATE INDEX IF NOT EXISTS idx_budget_store ON budget(store);
SQL
```

Also ensure `.browser-state/` and `grocery.db` are gitignored in the grocery-plan repo:

```bash
cd /workspace/extra/grocery-plan
grep -q 'grocery.db' .gitignore 2>/dev/null || cat >> .gitignore <<'EOF'
.browser-state/
grocery.db
grocery.db-journal
grocery.db-wal
EOF
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

After extracting a price, always normalize to a per-unit/per-weight price for comparison:
- Bulk packs: divide total price by quantity (e.g., 5 dozen eggs for $12.99 → $2.60/dozen)
- BOGO: record the effective price (half the listed price) and put "BOGO" in notes
- Per-weight: use $/lb as the standard (convert $/oz if needed: multiply by 16)

```bash
sqlite3 /workspace/extra/grocery-plan/grocery.db \
  "INSERT INTO prices (item, store, price, unit, notes) VALUES ('<item>', '<store>', <price>, '<unit>', '<notes>');"
```

The `price` column should always be the **effective per-unit price** so cross-store comparison is straightforward.

## Querying Prices

Get latest price for an item across all stores:

```bash
sqlite3 -header -column /workspace/extra/grocery-plan/grocery.db \
  "SELECT store, price, unit, notes, scraped_at FROM prices WHERE item = '<item>' ORDER BY scraped_at DESC LIMIT 5;"
```

Get rolling average for an item at a store (last 30 days):

```bash
sqlite3 /workspace/extra/grocery-plan/grocery.db \
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
8. Note the package size for unit price calculation (e.g., "5 dozen eggs" -> price per egg)
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
- **Item not found:** Try alternate search terms (e.g., "chicken breast" -> "boneless skinless chicken"). If still not found, skip and note "not found".
- **Auth expired:** Attempt re-login. If fails, skip store and alert user: "Could not authenticate with <store> — please check credentials."
- **CAPTCHA/bot detection:** Skip store and alert user. Add `agent-browser wait 2000` delays between items to reduce detection risk.
- **Price unclear:** If multiple prices shown (regular vs sale), record the lower effective price and note context.

## Close Browser When Done

Always close the browser after a scraping session to free resources:

```bash
agent-browser close
```
