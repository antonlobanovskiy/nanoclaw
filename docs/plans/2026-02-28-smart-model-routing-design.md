# Smart Model Routing

**Date:** 2026-02-28
**Status:** Approved

## Overview

Dynamically choose between `claude-opus-4-6` and `claude-sonnet-4-6` per message using a Haiku classifier inside the container agent-runner. Surface the selected model in the dashboard transcript.

## Priority Chain

1. **Explicit user override** — message contains `@opus` or `@sonnet` → use that model, skip classifier. The tag is stripped before forwarding to the agent.
2. **Haiku classifier** — runs on every message otherwise. Returns `opus` or `sonnet`.

## Classifier

A single Haiku API call before the main `query()` invocation. System prompt asks Haiku to evaluate whether the task requires deep reasoning, multi-step planning, complex code architecture, or creative work (→ opus) vs straightforward responses, simple lookups, status updates (→ sonnet). Returns a single word.

If the classifier fails (API error, timeout), default to Sonnet.

## Dashboard Integration

- Agent-runner streams back the selected model via a new `model` field in `ContainerOutput`
- Transcript viewer changes `[assistant]` → `[assistant · sonnet]` or `[assistant · opus]`

## Files to Change

| File | Change |
|------|--------|
| `container/agent-runner/src/index.ts` | Add Haiku classifier, parse user override, pass selected model to `query()` |
| `src/container-runner.ts` | Add `model` field to `ContainerOutput`, parse from agent output stream |
| `dashboard/transcript-viewer.js` | Show model name next to `[assistant]` |

## Out of Scope

- Per-group model pinning changes (already works via `containerConfig.model`)
- Caching classification results
- Fallback/retry if Haiku is down (just default to Sonnet)
