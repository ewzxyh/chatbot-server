# CaseZap Instance Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe per-instance CaseZap diagnostic surface that shows provider status, webhook freshness, recent events, and errors without exposing tokens or secrets.

**Architecture:** The server owns diagnostic aggregation because it already has access to integrations and operational events. The dashboard consumes a project-scoped endpoint and renders the diagnostic block beside each CaseZap instance. The webhook handler stores only small metadata about the latest received webhook, not raw payloads.

**Tech Stack:** Node.js/Express, Mongoose, Angular, existing operational events model.

---

### Task 1: Backend Diagnostic Contract

**Files:**
- Modify: `C:\Users\enzo\tiledesk-server\services\channelDiagnosticsService.js`
- Modify: `C:\Users\enzo\tiledesk-server\routes\integration.js`
- Test: `C:\Users\enzo\tiledesk-server\test\channelDiagnosticsService.test.js`

- [x] **Step 1: Add pure diagnostic helpers**

Add helpers that summarize an integration and operational events without `token`, `webhookSecret`, request bodies, or message contents.

- [x] **Step 2: Add service function**

Add `getCaseZapInstanceDiagnostics(integrationId, projectId, options)` to find the CaseZap integration inside the project, optionally force a provider check, fetch recent operational events, and return sanitized diagnostic data.

- [x] **Step 3: Add route**

Expose:

```text
GET /:projectid/integration/name/casezap/instances/:integration_id/diagnostics?force=true
```

The route must return 404 outside the project and 400 for non-CaseZap names.

- [x] **Step 4: Test contract**

Run:

```powershell
npm test -- --grep "channelDiagnosticsService"
```

Expected: existing provider health tests pass plus new diagnostic helper tests.

Result: focused Mocha run passed with 21 tests.

### Task 2: Webhook Receipt Metadata

**Files:**
- Modify: `C:\Users\enzo\tiledesk-server\pubmodules\casezap\connector.js`
- Test: `C:\Users\enzo\tiledesk-server\test\casezap\connector.test.js`

- [x] **Step 1: Extract receipt metadata**

Add a pure helper that extracts `eventType`, `messageType`, `messageId`, and `fromMe` from a CaseZap payload.

- [x] **Step 2: Persist latest receipt**

After a valid webhook secret and before event-specific branching, update the integration operational metadata:

```text
value.operational.lastWebhookReceivedAt
value.operational.lastWebhookReceivedEvent
value.operational.lastWebhookReceivedMessageId
value.operational.lastWebhookReceivedFromMe
value.operational.lastWebhookReceivedType
```

- [x] **Step 3: Test helper**

Run:

```powershell
npm test -- --grep "CaseZap connector"
```

Expected: connector helper tests pass and no secrets are included.

Result: covered by the focused Mocha run above.

### Task 3: Dashboard Diagnostics UI

**Files:**
- Modify: `C:\Users\enzo\tiledesk-dashboard\src\app\services\integration.service.ts`
- Modify: `C:\Users\enzo\tiledesk-dashboard\src\app\casezap\casezap.component.ts`
- Modify: `C:\Users\enzo\tiledesk-dashboard\src\app\casezap\casezap.component.html`
- Modify: `C:\Users\enzo\tiledesk-dashboard\src\app\casezap\casezap.component.scss`

- [x] **Step 1: Add service method**

Add `getIntegrationInstanceDiagnostics(name, integrationId, projectId, force)` that calls the new server route.

- [x] **Step 2: Render diagnostic panel**

Add a `Diagnostico` button per instance, showing saved status, provider health, last provider check, last webhook received, last registration, last error, and recent events.

- [x] **Step 3: Add refresh**

Add `Atualizar diagnostico` to call the endpoint with `force=true`.

- [x] **Step 4: Validate TypeScript**

Run the dashboard's fastest available static check or build command. If the repo has no lightweight check, run a targeted TypeScript parse/build command and report the limitation.

Result: `.\node_modules\.bin\tsc --noEmit --project src\tsconfig.app.json` passed. `npm run build` was attempted, but exceeded the local 3-minute timeout.

### Task 4: Commit, Push, and DEV Verification

**Files:**
- Server and dashboard git histories only.

- [ ] **Step 1: Review diffs**

Run:

```powershell
git diff --check
git diff --stat
```

- [ ] **Step 2: Commit server and dashboard separately**

Commit only files touched by this plan. Do not include unrelated dashboard deletion.

- [ ] **Step 3: Push**

Push both repositories to their current remotes.

- [ ] **Step 4: Deploy/verify DEV**

If SSH access is available, update the DEV stack at `69.6.250.104:18081`; otherwise report the blocker and exact local proof completed.
