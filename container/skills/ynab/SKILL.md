---
name: ynab
description: Query and manage YNAB (You Need A Budget) data via the API. Use for budget queries, category balances, transactions, accounts, and spending analysis.
allowed-tools: Bash(curl:*), Bash(jq:*)
---

# YNAB API Skill

## Authentication

The API token is stored at `/workspace/group/.ynab-token`. Read it once per session:

```bash
YNAB_TOKEN=$(cat /workspace/group/.ynab-token)
```

All requests use:
```bash
curl -s -H "Authorization: Bearer $YNAB_TOKEN" "https://api.ynab.com/v1/..."
```

## Common Endpoints

### List Budgets
```bash
curl -s -H "Authorization: Bearer $YNAB_TOKEN" "https://api.ynab.com/v1/budgets" | jq '.data.budgets[] | {id, name}'
```

### Get Budget Summary (use "last-used" or a specific budget ID)
```bash
curl -s -H "Authorization: Bearer $YNAB_TOKEN" "https://api.ynab.com/v1/budgets/last-used" | jq '.data.budget | {name, last_modified_on}'
```

### List Categories (shows all category groups and their categories with balances)
```bash
curl -s -H "Authorization: Bearer $YNAB_TOKEN" "https://api.ynab.com/v1/budgets/last-used/categories" | jq '.data.category_groups[] | {name, categories: [.categories[] | {name, balance: (.balance / 1000), budgeted: (.budgeted / 1000), activity: (.activity / 1000)}]}'
```

### List Accounts
```bash
curl -s -H "Authorization: Bearer $YNAB_TOKEN" "https://api.ynab.com/v1/budgets/last-used/accounts" | jq '.data.accounts[] | select(.closed == false) | {name, type, balance: (.balance / 1000), cleared_balance: (.cleared_balance / 1000)}'
```

### Get Transactions (current month)
```bash
curl -s -H "Authorization: Bearer $YNAB_TOKEN" "https://api.ynab.com/v1/budgets/last-used/transactions?since_date=$(date +%Y-%m-01)" | jq '.data.transactions[] | {date, amount: (.amount / 1000), payee_name, category_name, memo}'
```

### Get Transactions for a Specific Category
```bash
# First find the category ID from the categories endpoint, then:
curl -s -H "Authorization: Bearer $YNAB_TOKEN" "https://api.ynab.com/v1/budgets/last-used/categories/{category_id}/transactions" | jq '.data.transactions[] | {date, amount: (.amount / 1000), payee_name, memo}'
```

### Get Month Summary
```bash
curl -s -H "Authorization: Bearer $YNAB_TOKEN" "https://api.ynab.com/v1/budgets/last-used/months/current" | jq '.data.month | {month, income: (.income / 1000), budgeted: (.budgeted / 1000), activity: (.activity / 1000), to_be_budgeted: (.to_be_budgeted / 1000)}'
```

### Get Specific Month
```bash
curl -s -H "Authorization: Bearer $YNAB_TOKEN" "https://api.ynab.com/v1/budgets/last-used/months/2026-02-01" | jq '.data.month | {month, income: (.income / 1000), budgeted: (.budgeted / 1000), activity: (.activity / 1000)}'
```

### Scheduled Transactions (upcoming bills / recurring)
```bash
curl -s -H "Authorization: Bearer $YNAB_TOKEN" "https://api.ynab.com/v1/budgets/last-used/scheduled_transactions" | jq '.data.scheduled_transactions[] | {date_next, frequency, amount: (.amount / 1000), payee_name, category_name, memo}'
```

### Get Payees
```bash
curl -s -H "Authorization: Bearer $YNAB_TOKEN" "https://api.ynab.com/v1/budgets/last-used/payees" | jq '.data.payees[] | {id, name}'
```

### Create a Transaction
```bash
curl -s -X POST -H "Authorization: Bearer $YNAB_TOKEN" -H "Content-Type: application/json" \
  "https://api.ynab.com/v1/budgets/last-used/transactions" \
  -d '{
    "transaction": {
      "account_id": "ACCOUNT_ID",
      "date": "2026-03-06",
      "amount": -15000,
      "payee_name": "Store Name",
      "category_id": "CATEGORY_ID",
      "memo": "Description"
    }
  }' | jq '.data.transaction | {id, date, amount: (.amount / 1000), payee_name}'
```

### Update a Transaction
```bash
curl -s -X PUT -H "Authorization: Bearer $YNAB_TOKEN" -H "Content-Type: application/json" \
  "https://api.ynab.com/v1/budgets/last-used/transactions/{transaction_id}" \
  -d '{
    "transaction": {
      "amount": -20000,
      "memo": "Updated memo"
    }
  }' | jq '.data.transaction | {id, date, amount: (.amount / 1000), payee_name}'
```

### Delete a Transaction
```bash
curl -s -X DELETE -H "Authorization: Bearer $YNAB_TOKEN" \
  "https://api.ynab.com/v1/budgets/last-used/transactions/{transaction_id}" | jq '.data.transaction'
```

### Update Category Budget (move money / set budgeted amount for a month)
```bash
curl -s -X PATCH -H "Authorization: Bearer $YNAB_TOKEN" -H "Content-Type: application/json" \
  "https://api.ynab.com/v1/budgets/last-used/months/2026-03-01/categories/{category_id}" \
  -d '{
    "category": {
      "budgeted": 50000
    }
  }' | jq '.data.category | {name, budgeted: (.budgeted / 1000), balance: (.balance / 1000)}'
```

## Important Notes

- **Amounts are in milliunits** (divide by 1000 for dollars). $10.00 = 10000 milliunits.
- Negative amounts = outflows (spending). Positive = inflows (income).
- Use `last-used` as the budget ID to default to the user's primary budget.
- Rate limit: 200 requests per hour per access token.
- Always pipe through `jq` for readable output.
- When reporting balances/amounts to the user, always format as dollars (e.g., "$1,234.56").
