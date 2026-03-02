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

Also ensure `grocery.db` is gitignored in the grocery-plan repo:

```bash
cd /workspace/extra/grocery-plan
grep -q 'grocery.db' .gitignore 2>/dev/null || cat >> .gitignore <<'EOF'
grocery.db
grocery.db-journal
grocery.db-wal
EOF
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

All stores are scraped via Instacart — no login, no captcha, prices visible without authentication. Direct store websites (costco.com, walmart.com) block automated access.

### Publix (via Instacart)

**URL:** `https://delivery.publix.com/store/publix/search/<item>`

**Scraping an item:**
1. `agent-browser open https://delivery.publix.com/store/publix/search/<item>`
2. `agent-browser wait --load networkidle`
3. `agent-browser snapshot -i` — find product listing with price
4. Extract price with `agent-browser get text @<price-ref>`
5. Check for BOGO or sale tags — if present, note "BOGO" or "sale" in notes. BOGO effective price = half listed price.
6. Look for per-lb pricing on weighted items
7. Record in SQLite

**Tips:**
- delivery.publix.com is Instacart-powered, shows full per-lb pricing
- Publix deals reset every Wednesday — check Wednesday morning
- BOGO deals show on product cards

### Costco (via Instacart)

**URL:** `https://www.instacart.com/store/costco/search/<item>`

**Scraping an item:**
1. `agent-browser open https://www.instacart.com/store/costco/search/<item>`
2. `agent-browser wait --load networkidle`
3. `agent-browser snapshot -i` — find product listing with price
4. Extract price with `agent-browser get text @<price-ref>`
5. Note the package size for unit price calculation (e.g., "5 dozen eggs" -> price per egg)
6. Record in SQLite with unit = "per <unit>"

**Tips:**
- Instacart Costco prices may differ slightly from in-store member prices
- Note "instacart" in notes column
- Package sizes are usually shown — always calculate per-unit price

### Walmart (via Instacart)

**URL:** `https://www.instacart.com/store/walmart/search/<item>`

**Scraping an item:**
1. `agent-browser open https://www.instacart.com/store/walmart/search/<item>`
2. `agent-browser wait --load networkidle`
3. `agent-browser snapshot -i` — find product listing
4. Extract price with `agent-browser get text @<price-ref>`
5. Look for unit price if shown (e.g., "$0.12/oz")
6. Record in SQLite with unit price if available

**Tips:**
- Instacart claims "no markups" for Walmart
- Great Value store brand items are good for budget comparisons
- Look for "Rollback" tags = temporary price reduction

### Detwiler's (via Instacart)

**URL:** `https://www.instacart.com/store/detwilers-farm-market/search/<item>`

**Scraping an item:**
1. `agent-browser open https://www.instacart.com/store/detwilers-farm-market/search/<item>`
2. `agent-browser wait --load networkidle`
3. `agent-browser snapshot -i` — find product with price
4. Extract price with `agent-browser get text @<price-ref>`
5. Record in SQLite with notes = "instacart" (prices may differ from in-store)

**Tips:**
- Instacart prices are often 10-15% higher than in-store for Detwiler's
- Note this in the shopping list estimate ("Detwiler's prices are Instacart estimates")
- If Detwiler's is unavailable on Instacart, skip and note in output

### Trader Joe's (traderjoes.com)

**Auth:** None required. Direct website works.

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
- **CAPTCHA/bot detection:** Skip store and alert user. Add `agent-browser wait 2000` delays between items to reduce detection risk.
- **Price unclear:** If multiple prices shown (regular vs sale), record the lower effective price and note context.

## Close Browser When Done

Always close the browser after a scraping session to free resources:

```bash
agent-browser close
```
