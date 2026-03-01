# Smart Model Routing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Dynamically choose between Opus and Sonnet per message using a Haiku classifier, with user override support and dashboard visibility.

**Architecture:** Inside `agent-runner`, before calling the Claude Agent SDK `query()`, parse the prompt for explicit `@opus`/`@sonnet` tags. If none found, call Haiku via raw HTTP to classify complexity. Pass the selected model to `query()`. Stream the model name back to the host via `ContainerOutput`. Dashboard transcript viewer shows the model next to `[assistant]`.

**Tech Stack:** Node.js native `fetch` for Haiku API call (no new dependencies), Anthropic Messages API, existing JSONL transcript format.

---

### Task 1: Add Haiku classifier function to agent-runner

**Files:**
- Modify: `container/agent-runner/src/index.ts:358-421` (in `runQuery`, before `query()` call)

**Step 1: Write the classifier function**

Add this function above `runQuery` (around line 350):

```typescript
/**
 * Classify whether a prompt needs Opus or Sonnet using Haiku.
 * Returns 'claude-opus-4-6' or 'claude-sonnet-4-6'.
 */
async function classifyModel(
  prompt: string,
  apiKey: string,
): Promise<string> {
  const SONNET = 'claude-sonnet-4-6';
  const OPUS = 'claude-opus-4-6';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [
          {
            role: 'user',
            content: `Classify this task. Reply with exactly one word: "opus" or "sonnet".

Use "opus" for: complex multi-step planning, architectural decisions, debugging difficult issues, creative writing, nuanced analysis, tasks requiring deep reasoning, long-form content creation, code architecture.

Use "sonnet" for: simple questions, status updates, acknowledgments, lookups, straightforward code changes, short responses, factual answers, routine tasks.

Task: ${prompt.slice(0, 2000)}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      log(`Classifier HTTP error: ${response.status}`);
      return SONNET;
    }

    const data = await response.json() as {
      content: Array<{ type: string; text: string }>;
    };
    const answer = data.content?.[0]?.text?.trim().toLowerCase();

    if (answer?.includes('opus')) {
      log('Classifier chose: opus');
      return OPUS;
    }
    log('Classifier chose: sonnet');
    return SONNET;
  } catch (err) {
    log(`Classifier error: ${err instanceof Error ? err.message : String(err)}`);
    return SONNET;
  }
}
```

**Step 2: Run the build to verify no syntax errors**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat(agent-runner): add Haiku model classifier function"
```

---

### Task 2: Add user override parsing and wire classifier into runQuery

**Files:**
- Modify: `container/agent-runner/src/index.ts` — `runQuery` function and `main` function

**Step 1: Add override parsing function**

Add above `classifyModel`:

```typescript
/**
 * Check if the prompt contains an explicit model override (@opus or @sonnet).
 * Returns { model, cleanPrompt } where cleanPrompt has the tag stripped.
 */
function parseModelOverride(prompt: string): { model: string | null; cleanPrompt: string } {
  const opusMatch = prompt.match(/\b@opus\b/i);
  if (opusMatch) {
    return {
      model: 'claude-opus-4-6',
      cleanPrompt: prompt.replace(/\b@opus\b/i, '').trim(),
    };
  }
  const sonnetMatch = prompt.match(/\b@sonnet\b/i);
  if (sonnetMatch) {
    return {
      model: 'claude-sonnet-4-6',
      cleanPrompt: prompt.replace(/\b@sonnet\b/i, '').trim(),
    };
  }
  return { model: null, cleanPrompt: prompt };
}
```

**Step 2: Wire into main() to resolve model before first runQuery**

In `main()`, after the prompt is built (around line 538), add model resolution:

```typescript
  // Resolve model: user override > classifier > config > default
  const apiKey = sdkEnv.ANTHROPIC_API_KEY || sdkEnv.CLAUDE_CODE_OAUTH_TOKEN || '';
  const { model: overrideModel, cleanPrompt } = parseModelOverride(prompt);
  prompt = cleanPrompt;

  let resolvedModel: string;
  if (overrideModel) {
    resolvedModel = overrideModel;
    log(`Model override: ${resolvedModel}`);
  } else if (containerInput.model) {
    resolvedModel = containerInput.model;
    log(`Model from config: ${resolvedModel}`);
  } else {
    resolvedModel = await classifyModel(prompt, apiKey);
    log(`Model from classifier: ${resolvedModel}`);
  }
```

**Step 3: Pass resolvedModel into runQuery**

Add `resolvedModel` parameter to `runQuery` signature:

Change the signature from:
```typescript
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
```

To:
```typescript
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resolvedModel: string,
  resumeAt?: string,
```

**Step 4: Use resolvedModel in the query() call**

Change line 421 from:
```typescript
      model: (containerInput.model || 'claude-sonnet-4-6') as any,
```

To:
```typescript
      model: resolvedModel as any,
```

**Step 5: Update the runQuery call in main()**

Change the call at line 546 from:
```typescript
      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt);
```

To:
```typescript
      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resolvedModel, resumeAt);
```

**Step 6: For follow-up messages in the query loop, re-classify**

After `prompt = nextMessage;` (line 575), add:

```typescript
      // Re-classify model for follow-up messages
      const followUp = parseModelOverride(prompt);
      prompt = followUp.cleanPrompt;
      if (followUp.model) {
        resolvedModel = followUp.model;
        log(`Follow-up model override: ${resolvedModel}`);
      } else if (!containerInput.model) {
        resolvedModel = await classifyModel(prompt, apiKey);
        log(`Follow-up model from classifier: ${resolvedModel}`);
      }
```

**Step 7: Build and verify**

Run: `cd container/agent-runner && npx tsc --noEmit`
Expected: No errors

**Step 8: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat(agent-runner): wire Haiku classifier and @opus/@sonnet overrides into query loop"
```

---

### Task 3: Stream selected model back to host via ContainerOutput

**Files:**
- Modify: `container/agent-runner/src/index.ts` — `ContainerOutput` interface, `writeOutput` calls in `runQuery`
- Modify: `src/container-runner.ts` — `ContainerOutput` interface

**Step 1: Add `model` field to ContainerOutput in agent-runner**

In `container/agent-runner/src/index.ts`, change line 34-39:

```typescript
interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  model?: string;
}
```

**Step 2: Add `model` field to ContainerOutput in container-runner**

In `src/container-runner.ts`, change line 45-50:

```typescript
export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  model?: string;
}
```

**Step 3: Include model in writeOutput calls**

In `runQuery`, the result `writeOutput` (around line 482) currently is:

```typescript
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId
      });
```

Change to:

```typescript
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId,
        model: resolvedModel,
      });
```

This requires `resolvedModel` to be accessible in `runQuery` — it already is since we added it as a parameter in Task 2.

Also update the session-update `writeOutput` after the query loop iteration (line 563):

```typescript
      writeOutput({ status: 'success', result: null, newSessionId: sessionId, model: resolvedModel });
```

**Step 4: Build and verify**

Run: `cd container/agent-runner && npx tsc --noEmit && cd ../.. && npx tsc --noEmit`
Expected: No errors in either project

**Step 5: Commit**

```bash
git add container/agent-runner/src/index.ts src/container-runner.ts
git commit -m "feat: stream selected model name in ContainerOutput"
```

---

### Task 4: Show model in dashboard transcript viewer

**Files:**
- Modify: `dashboard/transcript-viewer.js:102-106` (assistant rendering)
- Modify: `dashboard/lib.js:135-148` (parseJsonlEvent assistant case)

**Step 1: Update parseJsonlEvent to extract model info**

The JSONL transcript doesn't directly contain our `model` field — it's SDK output. However, we can infer the model from the JSONL `system/init` message which contains model info, or we can write a side-channel file.

Simpler approach: write a small file `/workspace/ipc/model.txt` from agent-runner with the resolved model name. The dashboard can read it from `data/sessions/{group}/ipc/model.txt`.

In `agent-runner/src/index.ts`, in `main()` after model resolution, add:

```typescript
  // Write model selection for dashboard visibility
  try {
    fs.writeFileSync('/workspace/ipc/model.txt', resolvedModel);
  } catch { /* ignore */ }
```

**Step 2: Update transcript-viewer to read and display model**

In `dashboard/transcript-viewer.js`, add model reading. Import path at top:

Change:
```javascript
import {
  ESC, RESET, BOLD, DIM, GRAY, GREEN, CYAN, YELLOW,
  findLatestJsonl, parseJsonlEvent, AGENT_FILE,
} from './lib.js';
```

To:
```javascript
import {
  ESC, RESET, BOLD, DIM, GRAY, GREEN, CYAN, YELLOW,
  findLatestJsonl, parseJsonlEvent, AGENT_FILE, SESSIONS_DIR,
} from './lib.js';
```

Add model reading function:

```javascript
function readAgentModel(groupName) {
  try {
    const modelFile = path.join(SESSIONS_DIR, '..', 'ipc', groupName, 'model.txt');
    return fs.readFileSync(modelFile, 'utf8').trim().replace('claude-', '').replace('-4-6', '');
  } catch {
    return null;
  }
}
```

Wait — the IPC path structure. Let me check.

Actually, the IPC dir is at `data/ipc/{groupFolder}/`. Let me verify.

**Step 2 (revised): Read model from IPC directory**

In `dashboard/transcript-viewer.js`, after the `path` import, add:

```javascript
import path from 'path';
```

And add the model reader:

```javascript
let currentModel = null;

function readAgentModel(groupName) {
  if (!groupName) return null;
  try {
    // IPC dir: data/ipc/{groupFolder}/model.txt
    const modelFile = path.join(BASE, 'data', 'ipc', groupName, 'model.txt');
    return fs.readFileSync(modelFile, 'utf8').trim();
  } catch {
    return null;
  }
}
```

**Step 3: Update the assistant label in render()**

Change line 103:
```javascript
        allLines.push(`${GREEN}${BOLD}[assistant]${RESET}`);
```

To:
```javascript
        const modelTag = currentModel
          ? currentModel.replace('claude-', '').replace('-4-6', '')
          : null;
        allLines.push(`${GREEN}${BOLD}[assistant${modelTag ? ` · ${modelTag}` : ''}]${RESET}`);
```

**Step 4: Poll model in the agent selection poller**

In `pollAgentSelection()`, after setting `selectedAgent`, add:

```javascript
      currentModel = readAgentModel(name);
```

And add to the render interval:

```javascript
// Update model periodically
setInterval(() => {
  if (selectedAgent) currentModel = readAgentModel(selectedAgent);
}, 2000);
```

**Step 5: Verify the IPC path is correct**

Run: `ls data/ipc/ 2>/dev/null || echo "IPC dir structure needs checking"`

Check `src/group-folder.ts` for the `resolveGroupIpcPath` function to confirm the path.

**Step 6: Commit**

```bash
git add container/agent-runner/src/index.ts dashboard/transcript-viewer.js
git commit -m "feat(dashboard): show active model (opus/sonnet) next to [assistant] in transcript"
```

---

### Task 5: Rebuild container and test end-to-end

**Files:**
- No code changes — build and verify

**Step 1: Build agent-runner**

Run: `cd container/agent-runner && npm run build`
Expected: Successful compilation

**Step 2: Rebuild container image**

Run: `./container/build.sh`
Expected: Successful build

**Step 3: Verify by checking logs**

Send a simple message to the bot and check container logs for classifier output:
- `tail -f logs/nanoclaw.log | grep -i "classifier\|model"`
- Expected: Lines like `[agent-runner] Classifier chose: sonnet` or `Model from classifier: claude-sonnet-4-6`

**Step 4: Test @opus override**

Send a message starting with `@opus tell me a joke` and verify logs show `Model override: claude-opus-4-6`

**Step 5: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: address issues found during testing"
```
