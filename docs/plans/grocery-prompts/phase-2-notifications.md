@Tony Set up the following notification schedule using the schedule_task IPC tool. Each notification should be a cron-based scheduled task that sends a helpful message to this channel.

**Notifications to create:**

1. **Weekday Lunch Prep (Mon-Fri, 7:00 AM ET)**
   Cron: `0 7 * * 1-5`
   Prompt: "Check today's school lunch rotation in /workspace/extra/grocery-plan/school-lunches.md. Tell me what to pack for Olivia today, including specific items and any prep needed. Keep it to 3-4 bullet points."

2. **Weekday Dinner Prep (Mon-Fri, 3:30 PM ET)**
   Cron: `30 15 * * 1-5`
   Prompt: "Check today's dinner in /workspace/extra/grocery-plan/meal-plans/. Figure out which week we're on (A or B) from the monthly schedule, then tell me what's for dinner tonight and what to prep. Include timing, ingredients to pull from freezer/fridge, and cooking steps. Keep it practical."

3. **Saturday Full Day Plan (Saturday, 10:00 AM ET)**
   Cron: `0 10 * * 6`
   Prompt: "It's Saturday! Read /workspace/extra/grocery-plan/monthly-schedule.md and figure out today's plan. Give me: (1) Whether we're shopping today and where, (2) Breakfast/brunch suggestion, (3) Dinner plan for tonight. Keep it concise."

4. **Shopping Day List (Shopping days, 11:00 AM ET)**
   Cron: `0 11 * * 6` (Start with Saturday — we can add Wednesday for Publix later)
   Prompt: "Check /workspace/extra/grocery-plan/monthly-schedule.md for today's shopping plan. Read the relevant store shopping lists and on-hand inventory. Give me a store-by-store list of what to buy, organized by section/aisle. Include estimated cost per store if possible."

Use the `mcp__nanoclaw__schedule_task` tool to create each of these. Set context_mode to "group" so each notification has access to the grocery plan files.

After creating all tasks, list them back to me with their IDs so I can manage them.
