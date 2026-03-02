# Grocery Plan Overhaul — Design

## Goal

Update the grocery planning system with family preferences, meal swaps, new sections, notification system, and three new features (receipt scanning, price scraping, fridge/pantry photo scanning). All work is done by the NanoClaw grocery agent (TonyClaw), triggered via Discord.

## Architecture Decisions

### Model Override (per-group)

Add `model` field to `ContainerConfig` in types.ts. The agent-runner reads it from the container input and uses it instead of the hardcoded `claude-sonnet-4-6`. Default remains Sonnet; grocery group gets Opus for complex phases.

**Schema change:**
```typescript
interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number;
  model?: string; // e.g. "claude-opus-4-6"
}
```

**Flow:** `registered_groups.container_config.model` → `ContainerInput.model` → `agent-runner query({ model })`.

### Prompt Delivery

Send prompts to Discord #grocery channel via a one-shot Node script that uses the Discord API. The grocery group's trigger is checked — messages from the bot's own user ID are filtered, so we send as a webhook or use the `sendMessage` from NanoClaw's own Discord channel.

Simpler alternative: write a `scripts/send-grocery-prompt.ts` that:
1. Reads the Discord bot token from .env
2. Sends a message to channel `1477111298406879357` mentioning @TonyClaw
3. NanoClaw picks it up as a normal message

Even simpler: just paste prompts into Discord manually. The prompts are written in a plan doc.

**Decision: Manual paste.** The prompts need to be reviewed before sending anyway, and automation adds complexity for a one-time operation.

### Phased Execution

Each phase is a self-contained prompt that the agent can execute independently. Phases are ordered by dependency — content updates first (they inform later features), then notifications, then advanced features.

## Phases

### Phase 1: Content Updates (Opus)
- Meal swaps (Chili → Butter Chicken, Taco → Mom's Pasta, Fish Tacos → Zuppa Toscana)
- Add "What We Have" section (on-hand inventory before plan start)
- Add "Carry Over" section (leftover items for next month)
- Add ingredient alternatives section in meal plans
- Update school lunches (add juice boxes, fix cheese stick note)
- Add "Extras" section for Trader Joe's fun items
- Add bottled juices and occasional soda to shopping
- Fix Sunday (no heavy breakfast, church, dinner out)
- Update family preferences (Olivia, Galina, Anton favorites)
- Fix coffee (not Kirkland — specialty beans, cost-effective)
- Budget note: $450 per half-month, paid 1st and 15th, rental ~25th
- Unexpected expenses buffer ($50-75/month)
- Add Dad's Butter Chicken recipe details (batch sauce, freeze 4x)
- Add Mom's Pasta recipe details
- Update pantry staples with new items (juice boxes, Simply juices, pretzels, veggie straws, etc.)

### Phase 2: Notification System (Sonnet)
- Weekday 7am: Olivia's lunch prep notification
- Weekday 3:30pm: Dinner prep/cooking notification
- Saturday 10am: Full day plan (shopping, breakfast/brunch, dinner)
- Shopping days 11am: Store-specific shopping lists
- Implementation: scheduled tasks via IPC `schedule_task`

### Phase 3: Receipt Scanning (Opus)
- Send photo of receipt to bot
- OCR + parse items, prices, store, date
- Store in DB (item, price, quantity, store, date, category)
- Update remaining budget
- Track what was actually bought vs planned
- Flag unplanned purchases → ask user why → adjust plan or log as "unexpected"
- Needs: image processing (likely via Claude vision), SQLite schema, budget tracking logic

### Phase 4: Price Scraping (Opus, future)
- Scrape Publix, Costco, Walmart, Detwiler's websites for prices
- Build price DB for items we actually buy
- Cross-reference with receipt data
- Make budgeting realistic

### Phase 5: Fridge/Pantry Photo Scanning (Opus, future)
- Take photo of fridge/pantry contents
- AI identifies items and approximate quantities
- Update on-hand inventory automatically
- Feed into meal planning and shopping list generation
- Must be low-friction (no micromanaging)

## Out of Scope for Now
- Phases 4 and 5 are design-only in this round (too complex for immediate implementation)
- YNAB integration (separate system)
- iOS Shortcut modifications

## Files Changed

### NanoClaw (this repo)
- `src/types.ts` — Add `model` to ContainerConfig
- `src/container-runner.ts` — Pass model to container input
- `container/agent-runner/src/index.ts` — Read model from input, use in query()
- `groups/grocery/CLAUDE.md` — Comprehensive update with family context

### grocery-plan repo (by the agent)
- `meal-plans/week-a.md` — Taco → Mom's Pasta, ingredient alternatives
- `meal-plans/week-b.md` — Chili → Butter Chicken, Fish Tacos → Zuppa Toscana, ingredient alternatives
- `school-lunches.md` — Juice boxes, cheese stick note
- `budget.md` — Half-month allocation, unexpected buffer
- `shopping-lists/*.json` — Updated items for new meals
- `shopping-lists/costco.md` — Juice boxes, Simply juices, updated coffee
- `pantry-staples.md` — New items
- New: `on-hand.md` — Current inventory section
- New: `carry-over.md` — Month-to-month carryover
- New: `extras.md` — Trader Joe's extras section
- `store-strategy.md` — Coffee strategy, Trader Joe's section
- `CONTEXT.md` / `NOTES.md` — Updated with family names and preferences
