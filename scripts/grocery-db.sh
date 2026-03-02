#!/usr/bin/env bash
# grocery-db.sh — Interactive grocery database browser
DB="$HOME/dev/grocery-plan/grocery.db"

if [ ! -f "$DB" ]; then
  echo "Database not found at $DB"
  exit 1
fi

while true; do
  echo ""
  echo "=== Grocery DB ==="
  echo "1) Inventory (what's at home)"
  echo "2) Inventory — low/out only"
  echo "3) Shopping list (current)"
  echo "4) Budget (this month)"
  echo "5) Budget (all time)"
  echo "6) Prices (recent)"
  echo "7) Price history for an item"
  echo "8) Custom SQL query"
  echo "9) Full table list + row counts"
  echo "q) Quit"
  echo ""
  read -rp "> " choice

  case "$choice" in
    1)
      sqlite3 -header -column "$DB" \
        "SELECT item, category, quantity, status, updated_at FROM inventory ORDER BY category, item;"
      ;;
    2)
      sqlite3 -header -column "$DB" \
        "SELECT item, category, quantity, status, updated_at FROM inventory WHERE status IN ('low', 'out') ORDER BY category, item;"
      ;;
    3)
      read -rp "Week (leave blank for latest): " week
      if [ -z "$week" ]; then
        sqlite3 -header -column "$DB" \
          "SELECT item, store, category, quantity, printf('\$%.2f', price) as price, unit, CASE checked WHEN 1 THEN '✓' ELSE '' END as done, notes FROM shopping_list WHERE week = (SELECT week FROM shopping_list ORDER BY created_at DESC LIMIT 1) ORDER BY store, category, item;"
      else
        sqlite3 -header -column "$DB" \
          "SELECT item, store, category, quantity, printf('\$%.2f', price) as price, unit, CASE checked WHEN 1 THEN '✓' ELSE '' END as done, notes FROM shopping_list WHERE week = '$week' ORDER BY store, category, item;"
      fi
      ;;
    4)
      month_start=$(date +%Y-%m-01)
      sqlite3 -header -column "$DB" \
        "SELECT date, store, printf('\$%.2f', total) as total, items_count, notes FROM budget WHERE date >= '$month_start' ORDER BY date DESC;"
      echo ""
      sqlite3 -header -column "$DB" \
        "SELECT store, printf('\$%.2f', SUM(total)) as spent, COUNT(*) as trips FROM budget WHERE date >= '$month_start' GROUP BY store ORDER BY spent DESC;"
      echo ""
      total=$(sqlite3 "$DB" "SELECT printf('\$%.2f', COALESCE(SUM(total), 0)) FROM budget WHERE date >= '$month_start';")
      echo "Total this month: $total / \$900"
      ;;
    5)
      sqlite3 -header -column "$DB" \
        "SELECT date, store, printf('\$%.2f', total) as total, items_count, notes FROM budget ORDER BY date DESC;"
      ;;
    6)
      sqlite3 -header -column "$DB" \
        "SELECT item, store, printf('\$%.2f', price) as price, unit, notes, scraped_at FROM prices ORDER BY scraped_at DESC LIMIT 30;"
      ;;
    7)
      read -rp "Item name (partial ok): " item
      sqlite3 -header -column "$DB" \
        "SELECT item, store, printf('\$%.2f', price) as price, unit, notes, scraped_at FROM prices WHERE item LIKE '%$item%' ORDER BY scraped_at DESC LIMIT 20;"
      ;;
    8)
      read -rp "SQL> " sql
      sqlite3 -header -column "$DB" "$sql"
      ;;
    9)
      for table in inventory shopping_list prices budget; do
        count=$(sqlite3 "$DB" "SELECT COUNT(*) FROM $table;")
        echo "$table: $count rows"
      done
      ;;
    q|Q)
      exit 0
      ;;
    *)
      echo "Invalid choice"
      ;;
  esac
done
