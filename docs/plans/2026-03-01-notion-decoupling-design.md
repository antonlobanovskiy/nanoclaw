# Notion Decoupling — Design

**Date:** 2026-03-01
**Goal:** Remove Notion dependency from the grocery system. Replace with a single SQLite database (`grocery.db`) for all structured data. The Discord agent chat is the only interface.

## Why

- Notion adds no value — the agent handles everything via chat
- Markdown files are prone to hallucination for structured data (inventory, budget, prices)
- SQLite gives the agent exact queries instead of parsing markdown tables
- Simpler system: fewer moving parts, no API keys, no sync scripts

## Database: `grocery.db`

Single SQLite database at `/workspace/extra/grocery-plan/grocery.db` with 4 tables:

```sql
CREATE TABLE inventory (
    id INTEGER PRIMARY KEY,
    item TEXT NOT NULL,
    category TEXT NOT NULL,
    quantity TEXT,
    status TEXT DEFAULT 'ok',  -- ok, low, out
    last_restocked TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE shopping_list (
    id INTEGER PRIMARY KEY,
    item TEXT NOT NULL,
    store TEXT NOT NULL,
    category TEXT NOT NULL,
    quantity TEXT,
    price REAL,
    unit_price REAL,
    unit TEXT,
    checked INTEGER DEFAULT 0,
    week TEXT,                  -- "2026-03-01-A"
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    notes TEXT
);

CREATE TABLE prices (
    id INTEGER PRIMARY KEY,
    item TEXT NOT NULL,
    store TEXT NOT NULL,
    price REAL NOT NULL,
    unit TEXT,
    scraped_at TEXT NOT NULL DEFAULT (datetime('now')),
    notes TEXT
);

CREATE TABLE budget (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    store TEXT NOT NULL,
    total REAL NOT NULL,
    items_count INTEGER,
    notes TEXT,
    receipt_image TEXT
);

CREATE INDEX idx_inventory_status ON inventory(status);
CREATE INDEX idx_inventory_item ON inventory(item);
CREATE INDEX idx_shopping_list_week ON shopping_list(week);
CREATE INDEX idx_prices_item_store ON prices(item, store);
CREATE INDEX idx_prices_scraped_at ON prices(scraped_at);
CREATE INDEX idx_budget_date ON budget(date);
CREATE INDEX idx_budget_store ON budget(store);
```

## Workflow Changes

### Pantry Scan

**Before:** Update `on-hand.md` -> sync to Notion
**After:** UPDATE/INSERT `inventory` table directly

### Shopping List Generation

**Before:** Write JSON files -> sync to Notion -> Discord summary
**After:** Read meal plan markdown + query `inventory` for gaps -> scrape prices -> INSERT into `shopping_list` -> Discord summary

### Receipt Processing

**Before:** Update `budget.md` + `on-hand.md` -> sync both to Notion
**After:** INSERT into `budget` + UPDATE `inventory` (restock items)

### Budget Check

**Before:** Parse markdown table in `budget.md`
**After:** `SELECT store, SUM(total) FROM budget WHERE date >= '<month-start>' GROUP BY store`

### Daily Price Check

**Before (planned):** Reference `pantry-staples.md` for item list
**After:** Query items from recent `shopping_list` entries and `inventory` for frequently bought items

## What Gets Deleted

- `sync-to-notion.js` and Notion config (`.env` Notion keys, `.notion-ids.json`)
- All `node sync-to-notion.js` calls from grocery CLAUDE.md
- `shopping-lists/week-a-items.json`, `shopping-lists/week-b-items.json`
- `pantry-staples.md` (thresholds concept removed — shopping list is derived from meal plan vs inventory)
- References to Notion in file table and protocols

## What Stays as Markdown

- `meal-plans/week-a.md`, `meal-plans/week-b.md` — dinner rotations
- `school-lunches.md` — lunch rotation reference
- `store-strategy.md` — reference doc
- `monthly-schedule.md` — calendar template
- `carry-over.md` — short-lived notes
- `extras.md` — Trader Joe's fun items

## What Stays the Same

- All Discord notification formats
- Git commit protocol (still commit after each operation)
- Meal plan structure
- Monthly schedule

## Price Scraping Integration

The `prices` table in `grocery.db` replaces the separately planned `prices.db`. The `grocery-price-scraping` skill needs to be updated to point at `grocery.db` instead. The daily staple price check scheduled task queries frequently purchased items from `shopping_list` history rather than a static staples list.

## Data Migration

On first use after the switch, the agent should:
1. Create `grocery.db` with the schema above
2. Parse `on-hand.md` into `inventory` rows
3. Parse `budget.md` spend log into `budget` rows
4. The old markdown files are kept for reference but no longer updated

## No Changes to NanoClaw Core

All changes are in:
- `groups/grocery/CLAUDE.md` — updated protocols
- `container/skills/grocery-price-scraping/SKILL.md` — point at `grocery.db`
- Grocery-plan repo — delete `sync-to-notion.js`, add `grocery.db` to `.gitignore`
