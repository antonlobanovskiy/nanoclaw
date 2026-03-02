@Tony We want to build a receipt scanning feature. Here's the requirement:

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
