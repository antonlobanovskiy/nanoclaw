# Dashboard Writable Mount Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the dashboard directory writable inside the main group's container so the bot can edit dashboard source files via chat.

**Architecture:** Two config changes: (1) add the dashboard path to the external mount allowlist so the security layer permits it, (2) update the main group's `container_config` in SQLite to add a writable `additionalMount`, and (3) document the writable path in `groups/main/CLAUDE.md`.

**Tech Stack:** Node.js, better-sqlite3, JSON config file at `~/.config/nanoclaw/mount-allowlist.json`

---

### Task 1: Update mount allowlist

**Files:**
- Modify: `~/.config/nanoclaw/mount-allowlist.json`

**Step 1: Add the dashboard root**

Edit `~/.config/nanoclaw/mount-allowlist.json` to add the dashboard as an allowed read-write root:

```json
{
  "allowedRoots": [
    {
      "path": "~/dev/grocery-plan",
      "allowReadWrite": true,
      "description": "Family grocery and meal planning system"
    },
    {
      "path": "~/dev/NanoClaw/dashboard",
      "allowReadWrite": true,
      "description": "NanoClaw dashboard interface"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
```

**Step 2: Verify the file is valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync(require('os').homedir() + '/.config/nanoclaw/mount-allowlist.json', 'utf8')); console.log('valid')"`
Expected: `valid`

---

### Task 2: Update main group container_config in database

**Files:**
- Modify: `/home/antonlobanovskiy/dev/NanoClaw/store/messages.db` (via Node.js script)

**Step 1: Update the container_config for the main group**

Run from `/home/antonlobanovskiy/dev/NanoClaw`:

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('./store/messages.db');
const group = db.prepare(\"SELECT jid, container_config FROM registered_groups WHERE folder = 'main'\").get();
const config = JSON.parse(group.container_config);
config.additionalMounts.push({
  hostPath: '~/dev/NanoClaw/dashboard',
  containerPath: 'dashboard',
  readonly: false
});
db.prepare(\"UPDATE registered_groups SET container_config = ? WHERE folder = 'main'\").run(JSON.stringify(config));
console.log('Updated:', JSON.stringify(JSON.parse(db.prepare(\"SELECT container_config FROM registered_groups WHERE folder = 'main'\").get().container_config), null, 2));
"
```

Expected output: JSON with both the grocery-plan mount and the new dashboard mount.

---

### Task 3: Document writable dashboard path in main group CLAUDE.md

**Files:**
- Modify: `groups/main/CLAUDE.md`

**Step 1: Add dashboard section**

Add a new section to `groups/main/CLAUDE.md` explaining the writable dashboard path. Add it after the existing capabilities list:

```markdown
## Dashboard

The NanoClaw dashboard source code is mounted at `/workspace/extra/dashboard` (writable).

- Frontend (Vite/React): `/workspace/extra/dashboard/web/`
- API server: `/workspace/extra/dashboard/api/`

You can read and edit dashboard files directly. The dashboard runs separately — changes take effect after a rebuild (`npm run build` in the web directory) or on the next dev server restart.
```

**Step 2: Commit**

```bash
cd /home/antonlobanovskiy/dev/NanoClaw
git add groups/main/CLAUDE.md docs/plans/2026-02-28-dashboard-writable-mount.md
git commit -m "feat: mount dashboard as writable in main group container"
```

Note: The `mount-allowlist.json` and `messages.db` changes are not committed — they are local config/state files.
