# Grocery Plan Overhaul — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add per-group model override to NanoClaw, update the grocery group's CLAUDE.md with comprehensive family context, then trigger the grocery agent to execute a multi-phase plan that updates meal plans, adds new sections, sets up notifications, and designs receipt scanning.

**Architecture:** Three code changes in NanoClaw (model field in types, pass-through in container-runner, read in agent-runner), one CLAUDE.md update, then Discord-triggered agent execution in phases.

**Tech Stack:** TypeScript, Node.js, Claude Agent SDK, Discord.js

---

### Task 1: Add `model` field to ContainerConfig

**Files:**
- Modify: `src/types.ts:30-33`

**Step 1: Add model to ContainerConfig**

In `src/types.ts`, add `model` to the `ContainerConfig` interface:

```typescript
export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  model?: string;   // e.g. "claude-opus-4-6". Default: "claude-sonnet-4-6"
}
```

**Step 2: Add model to ContainerInput**

In `src/container-runner.ts`, add `model` to the `ContainerInput` interface:

```typescript
export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
  model?: string;
}
```

**Step 3: Pass model from group config to container input**

In `src/index.ts:333-342`, add `model` to the ContainerInput object:

```typescript
const output = await runContainerAgent(
  group,
  {
    prompt,
    sessionId,
    groupFolder: group.folder,
    chatJid,
    isMain,
    assistantName: ASSISTANT_NAME,
    model: group.containerConfig?.model,
  },
  // ... rest unchanged
```

Do the same in `src/task-scheduler.ts` where `runContainerAgent` is called.

**Step 4: Add model to agent-runner ContainerInput**

In `container/agent-runner/src/index.ts:22-31`, add `model` to the interface:

```typescript
interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
  model?: string;
}
```

**Step 5: Use model from input in query()**

In `container/agent-runner/src/index.ts:420`, change the hardcoded model:

```typescript
// Before:
model: 'claude-sonnet-4-6',

// After:
model: (containerInput.model || 'claude-sonnet-4-6') as any,
```

**Step 6: Build and verify**

```bash
npm run build
```

Expected: No errors.

**Step 7: Commit**

```bash
git add src/types.ts src/container-runner.ts src/index.ts src/task-scheduler.ts container/agent-runner/src/index.ts
git commit -m "feat: add per-group model override to container config"
```

---

### Task 2: Set grocery group model to Opus in DB

**Step 1: Update the grocery group's container config**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('store/messages.db');
const row = db.prepare('SELECT container_config FROM registered_groups WHERE folder = ?').get('grocery');
const config = JSON.parse(row.container_config);
config.model = 'claude-opus-4-6';
db.prepare('UPDATE registered_groups SET container_config = ? WHERE folder = ?').run(JSON.stringify(config), 'grocery');
console.log('Updated:', JSON.stringify(config, null, 2));
db.close();
"
```

**Step 2: Rebuild container image**

```bash
./container/build.sh
```

**Step 3: Restart NanoClaw**

```bash
systemctl --user restart nanoclaw
```

**Step 4: Verify it's running**

```bash
systemctl --user status nanoclaw
tail -5 logs/nanoclaw.log
```

Expected: "NanoClaw running" with no errors.

**Step 5: Commit**

No code changes to commit — DB update only.

---

### Task 3: Update grocery group CLAUDE.md

**Files:**
- Modify: `groups/grocery/CLAUDE.md`

**Step 1: Rewrite CLAUDE.md with comprehensive family context**

Replace the contents of `groups/grocery/CLAUDE.md` with a version that includes:
- Family members by name (Anton 30, Galina 30, Olivia 5, Andrew 1.5)
- Everyone's current food favorites (full lists from the user's notes)
- Budget structure ($900/month, $450 per half, paid 1st/15th, rental ~25th)
- Coffee note (specialty beans, not bulk Kirkland)
- Sunday schedule (church morning, dinner out, no heavy breakfast)
- Cheese stick note (Olivia doesn't want them in packed lunch — melt by lunch time)
- The full workspace file map
- Discord formatting rules
- Store information

The full content:

```markdown
# Grocery Assistant

You help manage a family grocery and meal planning system. Be concise and practical. Always read the relevant file before making changes.

## Family

| Who | Name | Age | Notes |
|-----|------|-----|-------|
| Dad | Anton | 30 | WFH, fitness journey (tracking calories, losing weight), costco whey protein, bananas every morning, generally happy with whatever everyone else eats |
| Mom | Galina | 30 | SAHM |
| Daughter | Olivia | 5 | School (nut-free policy), picky eater |
| Son | Andrew | 1.5 | Eats everything adults eat, just cut up |

**Location:** Sarasota, FL

### Olivia's Current Favorites
1. Simply mango juice (bottled)
2. Simply blueberry lemonade (bottled)
3. Cheese sticks — for on-the-go or at-home snack ONLY. They melt by lunch/snack time so she doesn't like them for packed school lunch.
4. Pretzels
5. Veggie straws
6. Popcorn, chips (Lays, Doritos)
7. Fruit: strawberries, blackberries, mango, apples, seasonal fruit
8. Veggies: mini cucumbers, baby carrots, Brussels sprouts, edamame
9. Meals: zuppa toscana, mashed potatoes, chicken in most meals, ground beef, burgers, nuggets, fries

### Galina's Current Favorites
1. Mornings: toast, muffins, pancakes, sometimes eggs and bacon (rare)
2. Boursin cheese
3. Jalapeño pita chips
4. Stroopwaffle cookies
5. Chocolates, danishes, etc. (for tea time)
6. Most fruits
7. Veggies: broccoli, Brussels sprouts, zucchini, cauliflower, salad/lettuce mixes, cherry tomatoes, all-color carrots, potatoes. NO green beans.
8. Meals: teriyaki chicken, steak and potatoes, pastas, burgers, Greek fries, salmon, sandwiches

### Anton's Current Favorites
1. Costco whey protein
2. Fitness journey — tracking calories, eating healthy
3. Generally happy with whatever everyone else is eating
4. Bananas every morning

## Budget

- **Total:** $900/month for groceries only (household goods separate)
- **Pay schedule:** Paid 1st and 15th. Rental income ~25th.
- **Strategy:** Allocate $450 at start of month to last until 15th, then other $450 for rest of month
- **As bulk pantry/freezer builds up**, the half-month stretch gets easier
- **Unexpected buffer:** ~$50-75/month for unplanned purchases. When unplanned items appear on receipts, ask why and either adjust the plan or log as "unexpected" expense.
- **Budgeting tool:** YNAB (separate system, don't integrate)

## Schedule Notes

- **Sundays:** No heavy breakfast (church in the morning), dinner out usually. Don't plan Sunday dinners.
- **Coffee:** We are coffee snobs. NOT bulk Costco/Kirkland coffee. Need a cost-effective way to get quality specialty beans (local roasters, online subscriptions, etc.)

## Your Workspace

The grocery planning repo is at `/workspace/extra/grocery-plan` (read-write). Key files:

| File | Purpose |
|------|---------|
| `README.md` | System overview |
| `budget.md` | Monthly budget by store |
| `meal-plans/week-a.md` | Week A dinner rotation |
| `meal-plans/week-b.md` | Week B dinner rotation |
| `shopping-lists/costco.md` | Costco bulk run |
| `shopping-lists/walmart.md` | Walmart fill-ins |
| `shopping-lists/publix.md` | Publix BOGO + fresh |
| `shopping-lists/detwilers.md` | Detwiler's produce + meat |
| `shopping-lists/costco-monthly.md` | Notion-synced Costco checklist |
| `shopping-lists/week-a-items.json` | Notion DB: Week A items |
| `shopping-lists/week-b-items.json` | Notion DB: Week B items |
| `school-lunches.md` | Olivia's nut-free lunch rotation |
| `pantry-staples.md` | Master pantry/freezer list |
| `store-strategy.md` | What to buy where and why |
| `monthly-schedule.md` | Monthly calendar template |
| `sync-to-notion.js` | Syncs markdown/JSON to Notion |
| `on-hand.md` | What we currently have (create if missing) |
| `carry-over.md` | Items carrying over to next month (create if missing) |
| `extras.md` | Trader Joe's extras/fun items (create if missing) |

## Stores

- **Costco**: 1-2x/month, bulk proteins/dairy/frozen/pantry
- **Detwiler's**: 1-2x/week, fresh seasonal produce + specialty meats
- **Publix**: Weekly, BOGO deals + fresh bread/deli
- **Walmart**: As needed, pantry fill-ins + household
- **Trader Joe's**: Occasional, fun/specialty items, unique sauces and snacks

## Discord Formatting

No markdown headings. Use:
- *Bold* (single asterisks)
- _Italic_ (underscores)
- • Bullets
- \`\`\`Code blocks\`\`\`
```

**Step 2: Commit**

```bash
git add groups/grocery/CLAUDE.md
git commit -m "feat(grocery): comprehensive CLAUDE.md with family context and preferences"
```

---

### Task 4: Write Phase 1 prompt — Content Updates

**Files:**
- Create: `docs/plans/grocery-prompts/phase-1-content-updates.md`

**Step 1: Write the Phase 1 prompt**

This is the prompt to paste into Discord #grocery (or send via Discord API). It tells the agent exactly what to do:

```markdown
@TonyClaw Here's a big content update for the grocery plan. Read ALL files in /workspace/extra/grocery-plan/ first, then make these changes. Do NOT ask questions — just implement everything. Commit changes to git when done.

**Meal Swaps:**
1. Week B: Replace "Slow Cooker Chili" (Tuesday) with "Dad's Butter Chicken" — Anton batch-creates the sauce (enough for 4 meals, freezes it). Uses chicken breast, lots of butter, lots of tomatoes, some misc spices. Note the batch-cook nature in the recipe.
2. Week A: Replace one taco night with "Mom's Pasta" — chicken, pasta, bacon, cherry tomatoes, spinach, heavy cream. Note that spinach can be skipped for kids if needed.
3. Week B: Replace "Fish Tacos" (Friday) with "Zuppa Toscana" soup night (Olivia loves it).

**New Sections to Add:**
4. Create `on-hand.md` — "What We Have Right Now" section. Template with categories (Freezer, Fridge, Pantry, Snacks) that we fill in before each plan period starts. This gets meshed with the shopping list to avoid buying what we already have.
5. Create `carry-over.md` — "Carry Over to Next Month" section. Track snacks, veggies, frozen items, pantry staples that carry over so they're considered in future meal planning.
6. Create `extras.md` — "Trader Joe's Extras" section for fun/specialty items (sauces, snacks, frozen meals, seasonal items) that can count toward meals and snacks.
7. In each meal plan (week-a.md, week-b.md), add an "Ingredient Alternatives" note under each meal where applicable. Example: avocado → not everyone's favorite, suggest alternatives.

**School Lunch Updates:**
8. Add juice boxes to Olivia's lunches — healthy ones from Costco (like Honest Kids or similar).
9. Add Simply mango juice and Simply blueberry lemonade (bottled) to the snack/drink options.
10. Note on cheese sticks: they melt by lunch time, so they're NOT for packed school lunch. Keep them as on-the-go or at-home snack only.

**Shopping & Budget Updates:**
11. Add bottled juices (Simply brand) and occasional soda to shopping lists.
12. Update `budget.md`: Anton gets paid 1st and 15th. $450 must last the first half of the month, then $450 for the second half. Add a $50-75/month "unexpected purchases" buffer. When we buy something not on the list, we need to ask why and either adjust the plan or log it.
13. Fix coffee: Remove Kirkland coffee references. Add a note that we need specialty/quality beans — suggest cost-effective options (local roasters, online subscriptions like Trade Coffee, Counter Culture, etc.)
14. Add veggie straws, pretzels, popcorn, Lays, Doritos to snack lists where appropriate.
15. Add Boursin, jalapeño pita chips, stroopwaffle cookies, chocolates/danishes to Galina's snack section.
16. Add bananas (Anton, every morning) and whey protein (Costco) if not already there.

**Schedule Updates:**
17. Sunday: Update both week plans — no heavy breakfast (church morning), no dinner planned (eating out). Remove or note any Sunday meals.

**General:**
18. Update `CONTEXT.md` and `NOTES.md` with family names (Anton, Galina, Olivia, Andrew) and ages.
19. Review and update `pantry-staples.md` with all new items mentioned above.
20. Run `node sync-to-notion.js` after all file changes to sync everything to Notion.

After completing everything, give me a summary of all changes made.
```

**Step 2: Save to file**

Save the prompt to `docs/plans/grocery-prompts/phase-1-content-updates.md`.

**Step 3: Commit**

```bash
git add docs/plans/grocery-prompts/phase-1-content-updates.md
git commit -m "docs: Phase 1 grocery agent prompt — content updates"
```

---

### Task 5: Write Phase 2 prompt — Notification System

**Files:**
- Create: `docs/plans/grocery-prompts/phase-2-notifications.md`

**Step 1: Write the Phase 2 prompt**

```markdown
@TonyClaw Set up the following notification schedule using the schedule_task IPC tool. Each notification should be a cron-based scheduled task that sends a helpful message to this channel.

**Notifications to create:**

1. **Weekday Lunch Prep (Mon-Fri, 7:00 AM ET)**
   Cron: `0 7 * * 1-5`
   Prompt: "Check today's school lunch rotation in /workspace/extra/grocery-plan/school-lunches.md. Tell me what to pack for Olivia today, including specific items and any prep needed. Keep it to 3-4 bullet points."

2. **Weekday Dinner Prep (Mon-Fri, 3:30 PM ET)**
   Cron: `0 15 * * 1-5` (3 PM — NanoClaw uses ET, adjust if needed for 3:30 use `30 15 * * 1-5`)
   Prompt: "Check today's dinner in /workspace/extra/grocery-plan/meal-plans/. Figure out which week we're on (A or B) from the monthly schedule, then tell me what's for dinner tonight and what to prep. Include timing, ingredients to pull from freezer/fridge, and cooking steps. Keep it practical."

3. **Saturday Full Day Plan (Saturday, 10:00 AM ET)**
   Cron: `0 10 * * 6`
   Prompt: "It's Saturday! Read /workspace/extra/grocery-plan/monthly-schedule.md and figure out today's plan. Give me: (1) Whether we're shopping today and where, (2) Breakfast/brunch suggestion, (3) Dinner plan for tonight. Keep it concise."

4. **Shopping Day List (Shopping days, 11:00 AM ET)**
   Cron: `0 11 * * 6` (Start with Saturday — we can add Wednesday for Publix later)
   Prompt: "Check /workspace/extra/grocery-plan/monthly-schedule.md for today's shopping plan. Read the relevant store shopping lists and on-hand inventory. Give me a store-by-store list of what to buy, organized by section/aisle. Include estimated cost per store if possible."

Use the `mcp__nanoclaw__schedule_task` tool to create each of these. Set context_mode to "group" so each notification has access to the grocery plan files.

After creating all tasks, list them back to me with their IDs so I can manage them.
```

**Step 2: Save and commit**

```bash
mkdir -p docs/plans/grocery-prompts
# save file
git add docs/plans/grocery-prompts/phase-2-notifications.md
git commit -m "docs: Phase 2 grocery agent prompt — notifications"
```

---

### Task 6: Write Phase 3 prompt — Receipt Scanning Design

**Files:**
- Create: `docs/plans/grocery-prompts/phase-3-receipt-scanning.md`

**Step 1: Write the Phase 3 prompt**

This is the complex one — needs Opus-level thinking. The prompt asks the agent to DESIGN the feature first, not just implement it.

```markdown
@TonyClaw We want to build a receipt scanning feature. Here's the requirement:

**How it works:**
- I take a photo of a grocery receipt and send it to you in this Discord channel
- You process the image (OCR + parse)
- Extract: each item name, price, quantity, store name, date, category
- Store everything in a database (SQLite, at /workspace/extra/grocery-plan/receipts.db)
- Update the remaining grocery budget for the current period
- Track what we actually bought vs what was planned
- Flag any items not on our shopping list — ask me why we bought them, then either adjust the meal plan or log as "unexpected expense"

**Budget integration:**
- $900/month total, split $450 per half-month (1st-14th and 15th-end)
- Track spending per store, per category, per period
- Show remaining budget on request
- The $50-75 unexpected buffer should be tracked separately

**Database schema (design this thoughtfully):**
- receipts table: id, store, date, total, image_path, period (first_half/second_half), created_at
- receipt_items table: id, receipt_id, item_name, price, quantity, category, planned (bool), notes
- budget_periods table: period_start, period_end, allocated, spent, remaining
- price_history table: item_name, store, price, date (for tracking price changes over time)

**Your task:**
1. First, think through the design. Consider edge cases: partial receipts, tax lines, coupon discounts, BOGO items, items we buy that aren't on any list.
2. Write the SQLite schema to /workspace/extra/grocery-plan/receipts-schema.sql
3. Write a receipt parser module (Node.js) that can be called when I send a photo
4. The parser should use Claude's vision capability — you'll receive the image, describe what you see, then extract structured data
5. Create a budget tracker that reads from the DB and reports current spending
6. Update CONTEXT.md with how the receipt system works

Start with the design and schema. Show me the plan before implementing.
```

**Step 2: Save and commit**

```bash
git add docs/plans/grocery-prompts/phase-3-receipt-scanning.md
git commit -m "docs: Phase 3 grocery agent prompt — receipt scanning design"
```

---

### Task 7: Write Phase 4 & 5 prompts — Future features (design only)

**Files:**
- Create: `docs/plans/grocery-prompts/phase-4-price-scraping.md`
- Create: `docs/plans/grocery-prompts/phase-5-fridge-scanning.md`

These are lighter — just asking the agent to think through and document designs, not implement.

**Phase 4 prompt (price scraping):**
```markdown
@TonyClaw Design a price scraping system for our grocery stores. Think through and document (don't implement yet):

1. Which stores have scrapeable websites/APIs (Publix, Costco, Walmart, Detwiler's)?
2. What items from our shopping lists should we track prices for?
3. How to store price data and cross-reference with receipt data
4. Legal/ToS considerations for each store
5. Alternative approaches (price comparison apps/APIs like Basket, Instacart API, etc.)
6. Implementation priority and effort estimate

Write the design to /workspace/extra/grocery-plan/docs/price-scraping-design.md
```

**Phase 5 prompt (fridge/pantry scanning):**
```markdown
@TonyClaw Design a fridge/pantry photo scanning system. Think through and document (don't implement yet):

1. How to identify items and approximate quantities from a photo
2. How to update on-hand.md automatically based on photo analysis
3. How to make this low-friction (no micromanaging — just snap a photo occasionally)
4. How to integrate with shopping list generation (don't buy what we have)
5. How to handle the fact that photos won't capture everything perfectly
6. Frequency: how often should we scan? After shopping? Weekly?

Write the design to /workspace/extra/grocery-plan/docs/fridge-scanning-design.md
```

**Save and commit both.**

---

### Task 8: Rebuild container, restart, and send Phase 1

**Step 1: Rebuild container**

```bash
./container/build.sh
```

**Step 2: Restart NanoClaw**

```bash
systemctl --user restart nanoclaw
```

**Step 3: Verify it's running**

```bash
sleep 3 && tail -10 logs/nanoclaw.log
```

**Step 4: Send Phase 1 prompt to Discord**

Paste the Phase 1 prompt from `docs/plans/grocery-prompts/phase-1-content-updates.md` into Discord #grocery channel. The agent will pick it up and execute.

**Step 5: Monitor execution**

```bash
tail -f logs/nanoclaw.log
```

Watch for container spawn, agent output, and completion. The agent runs with Opus now and bypass permissions, so it should execute everything without asking.

---

## Execution Order

1. Tasks 1-3: NanoClaw code changes (model override + CLAUDE.md) — **do in this session**
2. Task 4-7: Write prompts — **do in this session**
3. Task 8: Build, restart, send Phase 1 — **do in this session, then wait for agent**
4. After Phase 1 completes: Send Phase 2 (notifications)
5. After Phase 2 completes: Send Phase 3 (receipt scanning)
6. Phases 4-5: Send when ready (design only, lower priority)

## Notes

- The grocery agent has `bypassPermissions` so it won't ask for confirmation
- Container timeout is 5 minutes by default — Phase 1 may need more. Consider setting `timeout` in containerConfig to 600000 (10 min) or higher.
- Each phase should be sent as a separate Discord message after the previous one completes
- Monitor `logs/nanoclaw.log` for progress and errors
