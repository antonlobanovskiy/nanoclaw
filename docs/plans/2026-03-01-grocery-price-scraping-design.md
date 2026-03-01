# Grocery Price Scraping — Design

**Date:** 2026-03-01
**Approach:** Agent-driven scraping (no new infrastructure)

## Goal

Enable the grocery agent to browse store websites, scrape current prices, and integrate cost estimates into the shopping list workflow. Two purposes:

1. **Pre-trip cost estimates** — when generating a shopping list, scrape prices for every item and include per-store and total cost estimates in the Discord notification. This is the primary use case: staying within the $900/month budget.
2. **Price tracking over time** — daily checks on key staples to spot deals and build a price history.

## Approach

Agent-driven using existing `agent-browser` tool (Playwright/Chromium CLI already installed in the container). No code changes to NanoClaw core. Implementation is entirely:

1. A new skill (`container/skills/grocery-price-scraping/SKILL.md`)
2. Updates to the grocery group's `CLAUDE.md`
3. Agent creates the SQLite DB on first run

### Why agent-driven (not dedicated scripts)

- Grocery store websites change layouts frequently — Claude can adapt, scripts break
- Staples list is ~20-40 items, not hundreds — token cost is manageable
- Agent can make smart decisions (site down, item out of stock, alternative found)
- All infrastructure already exists
- Can always add dedicated scripts later if needed

## Storage: SQLite

Database at `/workspace/extra/grocery-plan/prices.db`:

```sql
CREATE TABLE prices (
    id INTEGER PRIMARY KEY,
    item TEXT NOT NULL,
    store TEXT NOT NULL,
    price REAL NOT NULL,
    unit TEXT,            -- "per lb", "each", "per oz", "per 5doz"
    scraped_at TEXT NOT NULL,
    notes TEXT            -- "BOGO", "sale", "member price", "instacart"
);

CREATE INDEX idx_prices_item_store ON prices(item, store);
CREATE INDEX idx_prices_scraped_at ON prices(scraped_at);
```

## Per-Store Scraping Strategy

### Costco (costco.com)
- **Auth:** Login with provided credentials, save browser state for reuse
- **Method:** Search bar → product page → extract price
- **Notes:** Track unit prices (bulk sizes). Member pricing.

### Publix (publix.com)
- **Auth:** Account login for discount/member prices, save browser state
- **Method:** Set Sarasota store location. Weekly ad page for deals. Product search for specific items.
- **Notes:** Flag BOGO deals in the `notes` column. Check weekly ad every Wednesday.

### Walmart (walmart.com)
- **Auth:** None required (may set store location)
- **Method:** Product search → extract price + unit price (Walmart usually shows both)
- **Notes:** Easiest to scrape. Great Value brand matching.

### Detwiler's (via Instacart)
- **Auth:** Google auth for Instacart account, save browser state
- **Method:** Instacart product search for Detwiler's store
- **Notes:** Instacart prices may differ from in-store. Note "instacart" in notes column.

### Trader Joe's (traderjoes.com)
- **Auth:** None required
- **Method:** Product search → extract price
- **Notes:** Prices rarely change. Simple scraping.

### Auth State Management

All stores: login once via `agent-browser`, save state with `agent-browser state save <store>-auth.json` to the grocery workspace. Load on subsequent runs with `agent-browser state load`. Re-authenticate if state expires.

## Triggers & Workflows

### 1. Pre-Trip Price Scrape (integrated into Shopping Plan Generation)

This extends the existing Shopping Plan Generation protocol in the grocery CLAUDE.md. After step 8 (generate store-by-store list), the agent:

1. For each store's item list, open the store website and scrape current prices
2. Store all prices in SQLite
3. Calculate per-item cost (price x quantity), per-store subtotal, and trip total
4. Compare trip total against remaining monthly budget
5. Include cost breakdown in the Discord notification:

```
Shopping list is ready in Notion!

🏪 Publix (8 items): ~$67
  • Chicken thighs 3lb — $2.49/lb ($7.47) BOGO
  • Salmon fillet 2lb — $8.99/lb ($17.98)
  • Deli turkey 1/2lb — $4.99/lb ($2.50)
  • ...

🌿 Detwiler's (6 items): ~$34
  • Potatoes 5lb — $3.49
  • Spinach bag — $2.99
  • ...

🛒 Walmart (5 items): ~$22
  • Black beans x4 — $0.78 ea ($3.12)
  • ...

💰 Trip total: ~$123
📊 Month so far: $419 + $123 = $542 / $900 ($358 remaining)
```

If the trip total would exceed budget, flag it and suggest substitutions or items to skip.

### 2. Daily Staple Check (scheduled task)

- Runs once daily (morning)
- Checks ~20-30 key staples from `pantry-staples.md` across all stores
- Stores results in SQLite for historical tracking
- Sends Discord alert only if notable deals found (price dropped >15% from rolling average, BOGO, clearance):

```
🏷️ Price alert!
  • Chicken thighs at Publix: $2.49/lb (avg $4.19) — BOGO this week
  • Eggs at Walmart: $3.28/5doz (down from $4.12)
```

### 3. Ad-Hoc Lookup (user-triggered)

- User asks "how much is salmon at Costco?" or "compare chicken prices"
- Agent scrapes the requested item(s) and responds with current prices
- Also stores the result in SQLite

## What Changes

| Component | Change |
|-----------|--------|
| `container/skills/grocery-price-scraping/SKILL.md` | **New.** Per-store scraping playbooks, SQLite schema, error handling guidance |
| `groups/grocery/CLAUDE.md` | **Updated.** Extended Shopping Plan Generation protocol to include price scraping step. Add daily staple check scheduled task. Reference the new skill. |
| NanoClaw core (`src/`) | **No changes** |
| Dockerfile | **No changes** |
| Container runner | **No changes** |

## Error Handling

- **Site down/unreachable:** Skip that store, note in Discord message ("Costco prices unavailable — site down")
- **Item not found:** Log as NULL price, note in message
- **Auth expired:** Attempt re-login. If fails, skip store and alert user to re-authenticate
- **CAPTCHA/bot detection:** Alert user, skip store. Consider rotating user-agent or adding delays between requests
- **Timeout:** 30s per item max. Skip and move on if exceeded.
