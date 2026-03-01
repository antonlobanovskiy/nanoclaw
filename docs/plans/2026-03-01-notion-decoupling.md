# Notion Decoupling — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove all Notion dependencies from the grocery system, replacing markdown-based structured data with a single SQLite database (`grocery.db`) and making the Discord agent chat the only interface.

**Architecture:** Update the grocery group's CLAUDE.md to use SQLite queries instead of markdown file parsing for inventory, shopping lists, budget, and prices. Update the price scraping skill to use `grocery.db` instead of `prices.db`. Delete Notion sync references. Add a one-time data migration step.

**Tech Stack:** SQLite (via `sqlite3` CLI in container), Bash, markdown (meal plans stay as-is)

---

### Task 1: Update grocery-price-scraping skill — switch from `prices.db` to `grocery.db`

**Files:**
- Modify: `container/skills/grocery-price-scraping/SKILL.md`

**Step 1: Replace all `prices.db` references with `grocery.db`**

Replace every occurrence of `prices.db` with `grocery.db` throughout the file.

The Database Setup section should create ALL four tables (not just `prices`), since this skill may be the first to run and needs to ensure the full schema exists:

Replace the entire Database Setup section with:

```markdown
## Database Setup

On first use, create the SQLite database if it doesn't exist:

\```bash
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
\```
```

**Step 2: Update the gitignore section**

Replace the gitignore block to reference `grocery.db` instead of `prices.db`:

```bash
cd /workspace/extra/grocery-plan
grep -q 'grocery.db' .gitignore 2>/dev/null || cat >> .gitignore <<'EOF'
.browser-state/
grocery.db
grocery.db-journal
grocery.db-wal
EOF
```

**Step 3: Verify all `prices.db` references are gone**

Run: `grep -n 'prices.db' container/skills/grocery-price-scraping/SKILL.md`
Expected: No output.

**Step 4: Commit**

```bash
git add container/skills/grocery-price-scraping/SKILL.md
git commit -m "refactor(grocery): switch price scraping skill from prices.db to grocery.db"
```

---

### Task 2: Update grocery CLAUDE.md — file table and workspace section

**Files:**
- Modify: `groups/grocery/CLAUDE.md:61-83` (Your Workspace section)

**Step 1: Replace the file table**

Replace lines 61-83 with the updated table that removes Notion references, removes `pantry-staples.md`, and adds `grocery.db`:

```markdown
The grocery planning repo is at `/workspace/extra/grocery-plan` (read-write). Key files:

| File | Purpose |
|------|---------|
| `grocery.db` | SQLite database: inventory, shopping lists, prices, budget |
| `README.md` | System overview |
| `meal-plans/week-a.md` | Week A dinner rotation |
| `meal-plans/week-b.md` | Week B dinner rotation |
| `shopping-lists/costco.md` | Costco bulk run reference |
| `shopping-lists/walmart.md` | Walmart fill-ins reference |
| `shopping-lists/publix.md` | Publix BOGO + fresh reference |
| `shopping-lists/detwilers.md` | Detwiler's produce + meat reference |
| `school-lunches.md` | Olivia's nut-free lunch rotation |
| `store-strategy.md` | What to buy where and why |
| `monthly-schedule.md` | Monthly calendar template |
| `on-hand.md` | Legacy inventory (migrated to grocery.db) |
| `carry-over.md` | Items carrying over to next month (create if missing) |
| `extras.md` | Trader Joe's extras/fun items (create if missing) |
```

**Step 2: Verify the edit**

Run: Read `groups/grocery/CLAUDE.md` lines 59-84 to verify.

**Step 3: Commit**

```bash
git add groups/grocery/CLAUDE.md
git commit -m "refactor(grocery): update file table — remove Notion, add grocery.db"
```

---

### Task 3: Update grocery CLAUDE.md — Pantry Scan protocol

**Files:**
- Modify: `groups/grocery/CLAUDE.md:105-135` (Pantry Scan section)

**Step 1: Replace the "After confirmation" block (step 4)**

Replace lines 129-135 with:

```markdown
4. **After confirmation:**
   - Ensure the database exists: `sqlite3 /workspace/extra/grocery-plan/grocery.db` (the `grocery-price-scraping` skill creates the schema if needed)
   - For each confirmed item, upsert into the `inventory` table:
     ```bash
     sqlite3 /workspace/extra/grocery-plan/grocery.db \
       "INSERT INTO inventory (item, category, quantity, status, updated_at)
        VALUES ('<item>', '<category>', '<quantity>', '<status>', datetime('now'))
        ON CONFLICT(id) DO UPDATE SET quantity=excluded.quantity, status=excluded.status, updated_at=datetime('now');"
     ```
   - Or if updating existing items by name:
     ```bash
     sqlite3 /workspace/extra/grocery-plan/grocery.db \
       "UPDATE inventory SET quantity='<quantity>', status='<status>', updated_at=datetime('now') WHERE item='<item>';"
     ```
   - If an item doesn't exist yet, INSERT it. If it does, UPDATE it.
   - Update `/workspace/extra/grocery-plan/carry-over.md` — move items to use soon, note well-stocked items to skip buying
   - Commit: `cd /workspace/extra/grocery-plan && git add -A && git commit -m "pantry-scan: update inventory $(date +%Y-%m-%d)"`
   - Then immediately proceed to generate the shopping plan (see Shopping Plan Generation below)
```

**Step 2: Verify the edit**

Run: Read `groups/grocery/CLAUDE.md` lines 125-142 to verify.

**Step 3: Commit**

```bash
git add groups/grocery/CLAUDE.md
git commit -m "refactor(grocery): pantry scan uses SQLite inventory instead of on-hand.md"
```

---

### Task 4: Update grocery CLAUDE.md — Shopping Plan Generation protocol

**Files:**
- Modify: `groups/grocery/CLAUDE.md:137-189` (Shopping Plan Generation section)

**Step 1: Replace the Shopping Plan Generation section**

Replace the entire section (from "Triggered after pantry scan" through the Discord summary) with:

```markdown
Triggered after pantry scan is confirmed. Also triggered if Anton says "generate shopping list" or similar.

1. Read `monthly-schedule.md` to determine if it's Week A or Week B. **If it's blank or a new month, populate it first:** fill in all dates for the month, week rotation (A/B alternating), Costco run dates (2nd and 4th Saturdays), Publix every Wednesday.
2. Read the current week's meal plan based on the week determined above.
3. Query current inventory from SQLite:
   ```bash
   sqlite3 -header -column /workspace/extra/grocery-plan/grocery.db \
     "SELECT item, category, quantity, status FROM inventory ORDER BY category, item;"
   ```
4. Read `carry-over.md` — check what's overstocked or needs to be used up. Do NOT re-buy items listed as well-stocked.
5. Read `school-lunches.md` for Olivia's weekly needs.
6. Cross-reference: what does the meal plan need that we don't have or are low on? (Check inventory status = 'low' or 'out', or items not in inventory at all.)
7. Generate the full item list from steps 4-6 (don't assign stores yet).
8. **Scrape prices across stores** using the `grocery-price-scraping` skill:
   - For each item, scrape the current price at **all relevant stores** (not just the default store)
   - BOGO deals count as half price (e.g., $5.99 BOGO → effective $3.00)
   - Always compare on a **per-unit/per-weight basis** (e.g., $/lb, $/oz, $/each) — bulk packs from Costco may look expensive but be cheaper per unit
   - Record all prices in `grocery.db` `prices` table
9. **Assign each item to the cheapest store** based on scraped per-unit prices:
   - Use the store strategy (Detwiler's for produce, Publix for proteins, Walmart for pantry) only as a **starting default** — override it whenever another store is cheaper
   - Factor in BOGO, sale prices, and Rollback tags
   - If prices are within ~5% of each other, prefer the store where we're already shopping (fewer trips)
   - If a price can't be found, fall back to the default store strategy
   - Calculate: per-item cost (price x quantity), per-store subtotal, trip total
   - If trip total would exceed remaining monthly budget (query `budget` table), flag it and suggest items to defer or substitute
10. Insert items into the `shopping_list` table:
    ```bash
    sqlite3 /workspace/extra/grocery-plan/grocery.db \
      "INSERT INTO shopping_list (item, store, category, quantity, price, unit_price, unit, week, notes)
       VALUES ('<item>', '<store>', '<category>', '<qty>', <price>, <unit_price>, '<unit>', '<week-id>', '<notes>');"
    ```
11. Commit: `cd /workspace/extra/grocery-plan && git add -A && git commit -m "shopping-list: generate week [A/B] list $(date +%Y-%m-%d)"`
12. Send Discord summary with cost breakdown:
    ```
    Shopping list ready!

    🏪 Publix (X items): ~$XX
      • Chicken thighs 3lb — $2.49/lb ($7.47) BOGO ← saved $7.47 vs regular
      • Item 2 — $X.XX ea ($X.XX)
      • ...

    🌿 Detwiler's (X items): ~$XX [Instacart estimates]
      • Item 1 — $X.XX
      • ...

    🛒 Walmart (X items): ~$XX
      • Item 1 — $X.XX ea ($X.XX)
      • ...

    🔀 Moved to cheaper store:
      • Salmon → Walmart ($9.47/lb) instead of Publix ($11.99/lb)
      • Rice → Costco ($0.42/lb) instead of Walmart ($0.68/lb)

    💰 Trip total: ~$XXX (saved ~$XX vs default store assignments)
    📊 Month so far: $XXX + $XXX = $XXX / $900 ($XXX remaining)
    ```
```

**Step 2: Verify the edit**

Run: Read `groups/grocery/CLAUDE.md` lines 137-195 to verify.

**Step 3: Commit**

```bash
git add groups/grocery/CLAUDE.md
git commit -m "refactor(grocery): shopping list generation uses SQLite instead of JSON files"
```

---

### Task 5: Update grocery CLAUDE.md — Receipt Processing protocol

**Files:**
- Modify: `groups/grocery/CLAUDE.md` (Receipt Processing section, after Shopping Plan Generation)

**Step 1: Replace the Receipt Processing section**

Replace steps 2-7 with:

```markdown
2. **Log the spend** in SQLite:
   ```bash
   sqlite3 /workspace/extra/grocery-plan/grocery.db \
     "INSERT INTO budget (date, store, total, items_count, notes, receipt_image)
      VALUES ('<date>', '<store>', <total>, <item_count>, '<notes>', '<image_path>');"
   ```

3. **Update inventory** — for each purchased item, upsert into `inventory`:
   ```bash
   sqlite3 /workspace/extra/grocery-plan/grocery.db \
     "INSERT INTO inventory (item, category, quantity, status, last_restocked, updated_at)
      VALUES ('<item>', '<category>', '<quantity>', 'ok', '<date>', datetime('now'))
      ON CONFLICT(id) DO UPDATE SET quantity=excluded.quantity, status='ok', last_restocked=excluded.last_restocked, updated_at=datetime('now');"
   ```

4. **Mark items as checked** on the current shopping list:
   ```bash
   sqlite3 /workspace/extra/grocery-plan/grocery.db \
     "UPDATE shopping_list SET checked=1 WHERE item='<item>' AND week='<current-week>' AND store='<store>';"
   ```

5. **Check for unexpected items** — anything on the receipt NOT in the current shopping list:
   ```bash
   -- For each receipt item, check if it's on the list
   sqlite3 /workspace/extra/grocery-plan/grocery.db \
     "SELECT COUNT(*) FROM shopping_list WHERE item LIKE '%<item>%' AND week='<current-week>';"
   ```
   - If count is 0: list in Discord: "I noticed these weren't on the plan: [item1], [item2]. What were they for?"
   - Wait for Anton's reply

6. **Commit:** `cd /workspace/extra/grocery-plan && git add -A && git commit -m "receipt: [store] $[total] $(date +%Y-%m-%d)"`

7. **Send summary to Discord:**
   ```
   Receipt processed!

   💰 Publix: $87.43
   📦 Inventory updated — added 12 items
   ✅ 10/12 items were on the plan
   🚨 2 unexpected items flagged (see above)

   Budget so far this month: $X / $900
   ```
```

**Step 2: Verify the edit**

Run: Read the Receipt Processing section to verify.

**Step 3: Commit**

```bash
git add groups/grocery/CLAUDE.md
git commit -m "refactor(grocery): receipt processing uses SQLite instead of markdown + Notion"
```

---

### Task 6: Update grocery CLAUDE.md — Budget Summary protocol

**Files:**
- Modify: `groups/grocery/CLAUDE.md` (Budget Summary section)

**Step 1: Replace the Budget Summary section**

Replace the entire section with:

```markdown
### Budget Summary

When Anton asks how much has been spent this month (or similar):

1. Query the budget table:
   ```bash
   sqlite3 -header -column /workspace/extra/grocery-plan/grocery.db \
     "SELECT store, SUM(total) as spent, COUNT(*) as trips
      FROM budget
      WHERE date >= '<month-start>'
      GROUP BY store
      ORDER BY spent DESC;"
   ```
2. Get the total:
   ```bash
   sqlite3 /workspace/extra/grocery-plan/grocery.db \
     "SELECT SUM(total) FROM budget WHERE date >= '<month-start>';"
   ```
3. Reply with:
   ```
   March spend so far:
   • Costco: $187 (2 trips)
   • Publix: $124 (4 trips)
   • Detwiler's: $67 (3 trips)
   • Walmart: $23 (1 trip)
   Total: $401 / $900 ($499 remaining)
   ```
```

**Step 2: Commit**

```bash
git add groups/grocery/CLAUDE.md
git commit -m "refactor(grocery): budget summary queries SQLite instead of parsing markdown"
```

---

### Task 7: Update grocery CLAUDE.md — Daily Staple Price Check and Ad-Hoc Lookup

**Files:**
- Modify: `groups/grocery/CLAUDE.md` (Daily Staple Price Check and Ad-Hoc Price Lookup sections)

**Step 1: Replace the Daily Staple Price Check section**

Replace with:

```markdown
### Daily Price Check (Scheduled Task)

**Trigger:** Runs daily at 8:00 AM via scheduled task.

**Process:**

1. Query frequently purchased items from recent shopping lists:
   ```bash
   sqlite3 /workspace/extra/grocery-plan/grocery.db \
     "SELECT DISTINCT item, store FROM shopping_list WHERE created_at > datetime('now', '-60 days') ORDER BY item;"
   ```
2. For each item, scrape the current price at its most recent store using the `grocery-price-scraping` skill.
3. Record all prices in `grocery.db` `prices` table.
4. Compare each price against its 30-day rolling average:
   ```bash
   sqlite3 /workspace/extra/grocery-plan/grocery.db \
     "SELECT ROUND(AVG(price), 2) FROM prices WHERE item = '<item>' AND store = '<store>' AND scraped_at > datetime('now', '-30 days');"
   ```
5. If any item's price dropped >15% below its rolling average, or has a BOGO/sale tag, send a Discord alert:
   ```
   Price alert!
     • Chicken thighs at Publix: $2.49/lb (avg $4.19) — BOGO this week
     • Eggs at Walmart: $3.28/5doz (down from $4.12)
   ```
6. If no notable deals found, do NOT send a message (silent check).
7. Close the browser when done: `agent-browser close`
```

**Step 2: Update the Ad-Hoc Price Lookup section**

Replace `prices.db` references with `grocery.db`:

```markdown
### Ad-Hoc Price Lookup

When Anton asks about a specific item's price (e.g., "how much is salmon at Costco?"):

1. Scrape the current price using the `grocery-price-scraping` skill.
2. Check the price history from `grocery.db`:
   ```bash
   sqlite3 -header -column /workspace/extra/grocery-plan/grocery.db \
     "SELECT store, price, unit, scraped_at FROM prices WHERE item LIKE '%<item>%' ORDER BY scraped_at DESC LIMIT 10;"
   ```
3. Reply with current price, recent trend, and comparison across stores if relevant:
   ```
   Salmon at Costco: $8.99/lb (wild-caught Atlantic, 3lb pack = $26.97)
   30-day avg: $9.49/lb — current price is 5% below average
   Publix: $11.99/lb (no sale this week)
   Walmart: $9.47/lb
   ```
```

**Step 3: Commit**

```bash
git add groups/grocery/CLAUDE.md
git commit -m "refactor(grocery): daily price check and ad-hoc lookup use grocery.db"
```

---

### Task 8: Update the daily price check scheduled task prompt

**Files:**
- Database: `store/messages.db` (scheduled_tasks table)

**Step 1: Update the scheduled task prompt**

The daily staple price check task was registered in Task 4 of the price scraping plan. Update its prompt to reference `grocery.db` and query recent shopping list items instead of `pantry-staples.md`:

```javascript
node -e "
const Database = require('better-sqlite3');
const db = new Database('store/messages.db');
db.prepare(\"UPDATE scheduled_tasks SET prompt = ? WHERE schedule_value = '0 8 * * *' AND group_folder = 'grocery'\").run(
  'Run the daily price check. Query frequently purchased items from the shopping_list table in grocery.db (last 60 days). For each item, scrape the current price at its most recent store using the grocery-price-scraping skill. Record all prices in grocery.db. Compare each price against its 30-day rolling average. If any item dropped >15% below average or has a BOGO/sale tag, send a Discord alert with the deals. If no notable deals, do NOT send a message (silent check). Always close the browser when done.'
);
console.log('Updated', db.prepare(\"SELECT prompt FROM scheduled_tasks WHERE schedule_value = '0 8 * * *' AND group_folder = 'grocery'\").get());
"
```

**Step 2: Verify**

Run the query above and check the output matches the new prompt.

---

### Task 9: Add data migration instructions to grocery CLAUDE.md

**Files:**
- Modify: `groups/grocery/CLAUDE.md` (add section after Your Workspace, before Stores)

**Step 1: Add a one-time migration section**

Insert after the file table and before `## Stores`:

```markdown
### One-Time Data Migration

If `grocery.db` doesn't exist yet, create it using the schema in the `grocery-price-scraping` skill, then migrate existing data:

1. Parse `on-hand.md` and INSERT each item into the `inventory` table
2. Parse `budget.md` spend log rows and INSERT each into the `budget` table
3. After migration, verify row counts make sense
4. Commit: `cd /workspace/extra/grocery-plan && git add -A && git commit -m "chore: migrate to grocery.db"`

The old markdown files (`on-hand.md`, `budget.md`) are kept for reference but no longer updated.
```

**Step 2: Commit**

```bash
git add groups/grocery/CLAUDE.md
git commit -m "docs(grocery): add one-time data migration instructions"
```

---

### Task 10: Clean up — remove dead references

**Files:**
- Modify: `groups/grocery/CLAUDE.md` — final pass

**Step 1: Search for any remaining Notion/prices.db/pantry-staples references**

Run: `grep -n -i 'notion\|sync-to-notion\|prices\.db\|pantry-staples\|week-a-items\.json\|week-b-items\.json' groups/grocery/CLAUDE.md`

If any remain, remove them.

**Step 2: Search the price scraping skill too**

Run: `grep -n 'prices\.db' container/skills/grocery-price-scraping/SKILL.md`

If any remain, replace with `grocery.db`.

**Step 3: Final commit**

```bash
git add groups/grocery/CLAUDE.md container/skills/grocery-price-scraping/SKILL.md
git commit -m "chore(grocery): remove all Notion and prices.db references"
```
