# Pricing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a full pricing page for ChatCase SaaS with plan comparison, CasePay PIX Automático subscription, and server-side quota enforcement for contacts, platforms, and members.

**Architecture:** Phase 1 updates the server billing backend (plans, subscribe, status, webhook). Phase 2 adds server-side quota enforcement inline in existing route handlers and services. Phase 3 builds the Angular dashboard component with a new lazy-loaded module and service. Each phase produces independently testable software.

**Tech Stack:** Node.js/Express (server), Angular 14 (dashboard), MongoDB/Mongoose, CasePay PIX Automático API

**Spec:** `docs/superpowers/specs/2026-04-26-pricing-page-design.md`

---

## File Structure

### Server (C:\Users\enzo\tiledesk-server)
| File | Action | Responsibility |
|---|---|---|
| `pubmodules/billing/plans.js` | Modify | Add displayName, prices, contacts/platforms to quotes |
| `models/profile.js` | Modify | Add billingPeriod, contacts/platforms to quotes schema |
| `pubmodules/billing/index.js` | Modify | Subscribe with billingPeriod/idempotency/cancel-old, status with usage, webhook with billingPeriod-aware subEnd + eventId guard |
| `services/QuoteManager.js` | Modify | Add contacts/platforms/members to PLANS_LIST |
| `services/leadService.js` | Modify | Add checkContactsQuota() method |
| `routes/lead.js` | Modify | Add hard limit check before lead creation |
| `routes/integration.js` | Modify | Add platforms quota check |
| `routes/project_user.js` | Modify | Add members quota check |

### Dashboard (C:\Users\enzo\tiledesk-dashboard)
| File | Action | Responsibility |
|---|---|---|
| `src/app/services/casepay.service.ts` | Create | HTTP client for CasePay billing endpoints |
| `src/app/casepay-pricing/casepay-pricing.module.ts` | Create | Lazy-loaded feature module |
| `src/app/casepay-pricing/casepay-pricing.component.ts` | Create | Pricing page logic |
| `src/app/casepay-pricing/casepay-pricing.component.html` | Create | Pricing page template |
| `src/app/casepay-pricing/casepay-pricing.component.scss` | Create | Pricing page styles |
| `src/app/app.routing.ts` | Modify | Swap 3 pricing routes to CasepayPricingModule |
| `src/app/app.module.ts` | Modify | Register CasepayService in providers |
| `src/app/utils/util.ts` | Modify | Add contacts/platforms to PLANS_LIST |

---

## Phase 1: Backend Billing Updates

### Task 1: Update plans.js with ChatCase pricing

**Files:**
- Modify: `C:\Users\enzo\tiledesk-server\pubmodules\billing\plans.js`

- [ ] **Step 1: Replace the PLANS object with updated ChatCase plans**

Replace the entire content of `pubmodules/billing/plans.js` with:

```javascript
const PLANS = {
  free: {
    name: 'Free',
    displayName: 'Iniciante',
    type: 'free',
    agents: 1,
    monthlyPrice: 0,
    annualPrice: 0,
    quotes: { chatbots: 2, kbs: 1, namespace: 1, contacts: 200, platforms: 1 },
    customization: {
      copilot: false,
      webhook: false,
      widgetUnbranding: false,
      smtpSettings: false,
      knowledgeBases: true,
      reindex: false,
      messanger: false,
      telegram: false,
      whatsapp: false,
      chatbot: true
    }
  },
  starter: {
    name: 'Starter',
    displayName: 'Standard',
    type: 'payment',
    agents: 5,
    monthlyPrice: 279,
    annualPrice: 2845.80,
    quotes: { chatbots: 5, kbs: 3, namespace: 3, contacts: 1000, platforms: 1 },
    customization: {
      copilot: false,
      webhook: true,
      widgetUnbranding: true,
      smtpSettings: false,
      knowledgeBases: true,
      reindex: false,
      messanger: false,
      telegram: true,
      whatsapp: true,
      chatbot: true
    }
  },
  pro: {
    name: 'Pro',
    displayName: 'Pro',
    type: 'payment',
    agents: 5,
    monthlyPrice: 549,
    annualPrice: 5599.80,
    quotes: { chatbots: 20, kbs: 10, namespace: 10, contacts: 11000, platforms: 5 },
    customization: {
      copilot: true,
      webhook: true,
      widgetUnbranding: true,
      smtpSettings: true,
      knowledgeBases: true,
      reindex: true,
      messanger: true,
      telegram: true,
      whatsapp: true,
      chatbot: true
    }
  },
  business: {
    name: 'Business',
    displayName: 'Enterprise',
    type: 'payment',
    agents: 10,
    monthlyPrice: 997,
    annualPrice: 10169.40,
    quotes: { chatbots: 100, kbs: 50, namespace: 50, contacts: 50000, platforms: 5 },
    customization: {
      copilot: true,
      webhook: true,
      widgetUnbranding: true,
      smtpSettings: true,
      knowledgeBases: true,
      reindex: true,
      messanger: true,
      telegram: true,
      whatsapp: true,
      chatbot: true
    }
  }
};

function getPlan(planName) {
  return PLANS[planName.toLowerCase()] || PLANS.free;
}

function getAllPlans() {
  return Object.entries(PLANS).map(([key, plan]) => ({ key, ...plan }));
}

module.exports = { PLANS, getPlan, getAllPlans };
```

- [ ] **Step 2: Verify GET /plans returns new structure**

```bash
curl -s http://localhost:3000/api/modules/payments/casepay/plans | python -m json.tool | head -20
```

Expected: First plan shows `"displayName": "Iniciante"`, `"monthlyPrice": 0`, `"contacts": 200`.

- [ ] **Step 3: Commit**

```bash
cd C:\Users\enzo\tiledesk-server
git add pubmodules/billing/plans.js
git commit -m "feat: update plans.js with ChatCase pricing, displayNames, and contact/platform quotas"
```

---

### Task 2: Add billingPeriod and quota fields to profile.js

**Files:**
- Modify: `C:\Users\enzo\tiledesk-server\models\profile.js:113-115`

- [ ] **Step 1: Add billingPeriod field after last_payment_at**

In `models/profile.js`, after the `last_payment_at` field (around line 113) and before the closing `}, { _id: false }` (line 115), add:

```javascript
  billingPeriod: {
    type: String,
    enum: ['monthly', 'annual'],
  },
```

The `quotes` field is already `type: Object` (line 33-34), so adding `contacts` and `platforms` inside it requires no schema change — Mongoose stores arbitrary keys in Object fields. The values come from `plans.js` when a plan is applied.

- [ ] **Step 2: Verify the server starts without errors**

```bash
cd C:\Users\enzo\tiledesk-server
node -e "require('./models/profile'); console.log('Profile schema loaded OK')"
```

Expected: `Profile schema loaded OK`

- [ ] **Step 3: Commit**

```bash
git add models/profile.js
git commit -m "feat: add billingPeriod field to profile schema"
```

---

### Task 3: Update subscribe endpoint with billingPeriod, idempotency, and cancel-old-mandate

**Files:**
- Modify: `C:\Users\enzo\tiledesk-server\pubmodules\billing\index.js:39-117`

- [ ] **Step 1: Replace the subscribe handler**

Replace the entire `router.post('/subscribe', ...)` handler (lines 39-117) with:

```javascript
router.post('/subscribe',
  [passport.authenticate(['basic', 'jwt'], { session: false }), validtoken],
  async function (req, res) {
    try {
      var userId = req.user._id || req.user.id;
      var freshUser = await User.findById(userId).select('emailverified').lean();
      if (!freshUser || !freshUser.emailverified) {
        return res.status(403).json({
          error: 'email_not_verified',
          message: 'Verifique seu email antes de assinar um plano.'
        });
      }

      const { projectId, planKey, billingPeriod } = req.body;

      if (!projectId || !planKey) {
        return res.status(400).json({ error: 'projectId and planKey are required' });
      }

      const period = billingPeriod === 'annual' ? 'annual' : 'monthly';

      const plan = getPlan(planKey);
      if (!plan || plan.type === 'free') {
        return res.status(400).json({ error: 'Free plan does not require payment' });
      }

      const project = await Project.findById(projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      if (project.profile.pendingPlan && project.profile.mandateId) {
        try {
          const existingMandate = await casepay.getMandate(project.profile.mandateId);
          if (existingMandate.authorize_url) {
            return res.json({
              mandateId: project.profile.mandateId,
              authorizeUrl: existingMandate.authorize_url,
              status: existingMandate.status
            });
          }
        } catch (e) {
          winston.warn('CasePay: could not retrieve pending mandate, creating new one');
        }
      }

      if (project.profile.mandateId && !project.profile.pendingPlan) {
        try {
          await casepay.cancelMandate(project.profile.mandateId);
          winston.info(`CasePay: canceled old mandate ${project.profile.mandateId} for upgrade`);
        } catch (e) {
          winston.warn('CasePay: failed to cancel old mandate, proceeding with new one');
        }
      }

      const amount = period === 'annual' ? plan.annualPrice : plan.monthlyPrice;
      const interval = period === 'annual' ? 'YEARLY' : 'MONTHLY';

      const mandate = await casepay.createMandate({
        planName: plan.displayName || plan.name,
        amount,
        interval,
        firstPaymentAmount: amount,
        description: `${plan.displayName || plan.name} - ${project.name}`
      });

      const mandateId = mandate.mandate_id;
      const authorizeUrl = mandate.authorize_url;

      await Project.findByIdAndUpdate(projectId, {
        'profile.mandateId': mandateId,
        'profile.pendingPlan': planKey.toLowerCase(),
        'profile.paymentProvider': 'casepay',
        'profile.billingPeriod': period,
        'profile.type': 'payment'
      });

      await SubscriptionPayment.create({
        mandate_id: mandateId,
        project_id: projectId,
        user_id: req.user._id,
        plan_name: planKey,
        event_type: 'mandate_created',
        status: 'created',
        amount
      });

      winston.info(`CasePay mandate created for project ${projectId}: ${mandateId} (${period})`);

      res.json({
        mandateId,
        authorizeUrl,
        status: mandate.status
      });

    } catch (err) {
      winston.error('CasePay subscribe error', err);
      res.status(500).json({ error: 'Payment creation failed' });
    }
  }
);
```

- [ ] **Step 2: Test subscribe with monthly billing**

```bash
curl -X POST http://localhost:3000/api/modules/payments/casepay/subscribe \
  -H "Authorization: JWT <your-token>" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"<your-project-id>","planKey":"starter","billingPeriod":"monthly"}'
```

Expected: JSON with `mandateId`, `authorizeUrl`, `status`. Project profile should have `billingPeriod: 'monthly'` and `type: 'payment'`.

- [ ] **Step 3: Test idempotency (call again with same project)**

Run the same curl again. Expected: Returns the same `authorizeUrl` (not a new mandate).

- [ ] **Step 4: Commit**

```bash
git add pubmodules/billing/index.js
git commit -m "feat: subscribe endpoint with billingPeriod, idempotency, and cancel-old-mandate"
```

---

### Task 4: Update status endpoint with usage counts

**Files:**
- Modify: `C:\Users\enzo\tiledesk-server\pubmodules\billing\index.js:164-199`

- [ ] **Step 1: Add required imports at top of file**

At the top of `pubmodules/billing/index.js`, after the existing requires (around line 12), add:

```javascript
var Lead = require('../../models/lead');
var LeadConstants = require('../../models/leadConstants');
var Integration = require('../../models/integrations');
var Project_user = require('../../models/project_user');
```

- [ ] **Step 2: Replace the status handler**

Replace the entire `router.get('/status/:projectId', ...)` handler (lines 164-199) with:

```javascript
var CHANNEL_NAMES = ['whatsapp', 'telegram', 'messenger', 'sms', 'voice', 'voice_twilio'];

router.get('/status/:projectId',
  [passport.authenticate(['basic', 'jwt'], { session: false }), validtoken],
  async function (req, res) {
    try {
      const project = await Project.findById(req.params.projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const plan = getPlan(project.profile.name || 'free');

      const [contactsCount, platformsCount, agentsCount] = await Promise.all([
        Lead.countDocuments({ id_project: req.params.projectId, status: LeadConstants.NORMAL }),
        Integration.countDocuments({ id_project: req.params.projectId, name: { $in: CHANNEL_NAMES } }),
        Project_user.countDocuments({ id_project: req.params.projectId, status: 'active' })
      ]);

      const contactsLimit = (project.profile.quotes && project.profile.quotes.contacts) || plan.quotes.contacts || 200;
      const platformsLimit = (project.profile.quotes && project.profile.quotes.platforms) || plan.quotes.platforms || 1;
      const agentsLimit = project.profile.agents || plan.agents || 1;

      const response = {
        plan: project.profile.name,
        displayName: plan.displayName || project.profile.name,
        type: project.profile.type,
        billingPeriod: project.profile.billingPeriod || null,
        usage: {
          contacts: { current: contactsCount, limit: contactsLimit },
          platforms: { current: platformsCount, limit: platformsLimit },
          agents: { current: agentsCount, limit: agentsLimit }
        },
        mandateId: project.profile.mandateId || null,
        trialExpired: project.trialExpired,
        trialDaysLeft: project.trialDaysLeft
      };

      if (project.profile.mandateId) {
        try {
          const mandate = await casepay.getMandate(project.profile.mandateId);
          response.mandateStatus = mandate.status;
        } catch (e) {
          response.mandateStatus = 'unknown';
        }
      }

      res.json(response);

    } catch (err) {
      winston.error('CasePay status error', err);
      res.status(500).json({ error: 'Status check failed' });
    }
  }
);
```

- [ ] **Step 3: Test status endpoint**

```bash
curl -s http://localhost:3000/api/<project-id>/modules/payments/casepay/status/<project-id> \
  -H "Authorization: JWT <your-token>" | python -m json.tool
```

Expected: JSON with `usage.contacts`, `usage.platforms`, `usage.agents` containing `current` and `limit`.

- [ ] **Step 4: Commit**

```bash
git add pubmodules/billing/index.js
git commit -m "feat: status endpoint returns usage counts for contacts, platforms, agents"
```

---

### Task 5: Update webhook handler with billingPeriod-aware subEnd and eventId guard

**Files:**
- Modify: `C:\Users\enzo\tiledesk-server\pubmodules\billing\index.js:202-298`

- [ ] **Step 1: Add eventId guard at the start of the webhook handler**

In the webhook handler (`router.post('/webhook', ...)`), after the signature check and the destructuring of `req.body` (around line 209), add the eventId guard:

Find this line:
```javascript
    const { event, eventId, paymentRequestId, status, amount } = req.body;
```

Add immediately after:
```javascript
    if (!eventId) {
      winston.warn('CasePay webhook: missing eventId, rejecting');
      return res.status(400).json({ error: 'missing_event_id' });
    }
```

- [ ] **Step 2: Update payment_request/updated handler for billingPeriod-aware subEnd**

Find the block where `subEnd` is calculated for AUTHORIZED status (around lines 241-243). Replace:

```javascript
        const now = new Date();
        const subEnd = new Date(now);
        subEnd.setMonth(subEnd.getMonth() + 1);
        subEnd.setDate(subEnd.getDate() + 3);
```

With:

```javascript
        const now = new Date();
        const subEnd = new Date(now);
        const isAnnual = project.profile.billingPeriod === 'annual';
        subEnd.setMonth(subEnd.getMonth() + (isAnnual ? 12 : 1));
        subEnd.setDate(subEnd.getDate() + 3);
```

- [ ] **Step 3: Update automatic_pix_payment/completed handler for billingPeriod-aware subEnd**

Find the `automatic_pix_payment/completed` block (around lines 275-286). Replace:

```javascript
      const subEnd = new Date();
      subEnd.setMonth(subEnd.getMonth() + 1);
      subEnd.setDate(subEnd.getDate() + 3);
```

With:

```javascript
      const subEnd = new Date();
      const isAnnual = project.profile.billingPeriod === 'annual';
      subEnd.setMonth(subEnd.getMonth() + (isAnnual ? 12 : 1));
      subEnd.setDate(subEnd.getDate() + 3);
```

- [ ] **Step 4: Also save billingPeriod in the payment_request/updated AUTHORIZED block**

In the `findByIdAndUpdate` call inside the AUTHORIZED block, add `'profile.billingPeriod'` to the update:

Find:
```javascript
          'profile.pendingPlan': null
```

Add after it (inside the same update object):
```javascript
          'profile.billingPeriod': project.profile.billingPeriod || 'monthly'
```

This preserves the billingPeriod that was set during subscribe.

- [ ] **Step 5: Commit**

```bash
git add pubmodules/billing/index.js
git commit -m "feat: webhook with billingPeriod-aware subEnd and eventId guard"
```

---

### Task 6: Update QuoteManager PLANS_LIST and dashboard PLANS_LIST

**Files:**
- Modify: `C:\Users\enzo\tiledesk-server\services\QuoteManager.js:17-30`
- Modify: `C:\Users\enzo\tiledesk-dashboard\src\app\utils\util.ts:446-457`

- [ ] **Step 1: Add contacts, platforms, members to server PLANS_LIST**

In `services/QuoteManager.js`, find the `PLANS_LIST` object (lines 17-30). Add `contacts`, `platforms`, and `members` to each plan entry. The existing fields (`requests`, `tokens`, `chatbots`, etc.) remain unchanged. Add the new fields at the end of each entry:

For `SANDBOX` / `FREE_TRIAL` entries, add: `contacts: 200, platforms: 1, members: 1`
For `STARTER` / `Basic` entries, add: `contacts: 1000, platforms: 1, members: 5`
For `PRO` / `PREMIUM` entries, add: `contacts: 11000, platforms: 5, members: 5`
For `BUSINESS` / `TEAM` / `CUSTOM` entries, add: `contacts: 50000, platforms: 5, members: 10`

Example for STARTER line:
```javascript
    STARTER:    { requests: 800,  messages: 0, tokens: 2000000,  voice_duration: 0,      email: 200, chatbots: 5,  namespace: 1,  kbs: 150, contacts: 1000, platforms: 1, members: 5 },
```

- [ ] **Step 2: Add contacts, platforms, members to dashboard PLANS_LIST**

In `src/app/utils/util.ts`, find `PLANS_LIST` (lines 446-457). Add the same fields to each entry:

```typescript
export const PLANS_LIST = {
    FREE_TRIAL: { requests: 3000, messages: 0, tokens: 5000000,  voice_duration: 120000, email: 200, chatbots: 5,  namespace: 1,  kbs: 150, contacts: 200,   platforms: 1, members: 1 },
    Sandbox:    { requests: 200,  messages: 0, tokens: 100000,   voice_duration: 0,      email: 200, chatbots: 2,  namespace: 1,  kbs: 50,  contacts: 200,   platforms: 1, members: 1 },
    Starter:    { requests: 800,  messages: 0, tokens: 2000000,  voice_duration: 0,      email: 200, chatbots: 5,  namespace: 1,  kbs: 150, contacts: 1000,  platforms: 1, members: 5 },
    Pro:        { requests: 3000, messages: 0, tokens: 5000000,  voice_duration: 0,      email: 200, chatbots: 20, namespace: 3,  kbs: 300, contacts: 11000, platforms: 5, members: 5 },
    Business:   { requests: 5000, messages: 0, tokens: 10000000, voice_duration: 0,      email: 200, chatbots: 50, namespace: 10, kbs: 1000, contacts: 50000, platforms: 5, members: 10 },
    Basic:      { requests: 800,  messages: 0, tokens: 2000000,  voice_duration: 0,      email: 200, chatbots: 5,  namespace: 1,  kbs: 150, contacts: 1000,  platforms: 1, members: 5 },
    Premium:    { requests: 3000, messages: 0, tokens: 5000000,  voice_duration: 0,      email: 200, chatbots: 20, namespace: 3,  kbs: 300, contacts: 11000, platforms: 5, members: 5 },
    Team:       { requests: 5000, messages: 0, tokens: 10000000, voice_duration: 0,      email: 200, chatbots: 50, namespace: 10, kbs: 1000, contacts: 50000, platforms: 5, members: 10 },
    Custom:     { requests: 5000, messages: 0, tokens: 10000000, voice_duration: 120000, email: 200, chatbots: 50, namespace: 10, kbs: 1000, contacts: 50000, platforms: 5, members: 10 }
}
```

- [ ] **Step 3: Commit both repos**

```bash
cd C:\Users\enzo\tiledesk-server
git add services/QuoteManager.js
git commit -m "feat: add contacts/platforms/members to QuoteManager PLANS_LIST"

cd C:\Users\enzo\tiledesk-dashboard
git add src/app/utils/util.ts
git commit -m "feat: add contacts/platforms/members to dashboard PLANS_LIST"
```

---

## Phase 2: Quota Enforcement

### Task 7: Add checkContactsQuota to leadService

**Files:**
- Modify: `C:\Users\enzo\tiledesk-server\services\leadService.js`

- [ ] **Step 1: Add required imports at top of leadService.js**

After the existing requires (line 1-7), add:

```javascript
var Project = require("../models/project");
var LeadConstants = require("../models/leadConstants");
var { getPlan } = require('../pubmodules/billing/plans');
```

- [ ] **Step 2: Add checkContactsQuota method to the LeadService class**

Add this method inside the `LeadService` class (after the constructor or at the end, before `module.exports`). Find the appropriate location (after the last method) and add:

```javascript
  async checkContactsQuota(id_project) {
    try {
      const project = await Project.findById(id_project).select('profile').lean();
      if (!project || !project.profile) {
        return { allowed: true, current: 0, limit: 0 };
      }

      const plan = getPlan(project.profile.name || 'free');
      const limit = (project.profile.quotes && project.profile.quotes.contacts) || plan.quotes.contacts || 200;
      const current = await Lead.countDocuments({ id_project: id_project, status: LeadConstants.NORMAL });

      const percent = limit > 0 ? Math.round((current / limit) * 100) : 0;
      const allowed = current < limit;

      if (percent >= 50 && leadEvent) {
        leadEvent.emit('lead.quota.threshold', { projectId: id_project, percent, current, limit });
      }

      return { allowed, current, limit, percent };
    } catch (err) {
      winston.error('checkContactsQuota error', err);
      return { allowed: true, current: 0, limit: 0 };
    }
  }
```

- [ ] **Step 3: Add soft limit check inside createWitId**

In the `createWitId` method (line 153), after `newLead.save()` callback resolves successfully (around line 178 where it does `leadEvent.emit('lead.create', savedLead)`), add the soft limit check:

Find this block:
```javascript
        leadEvent.emit('lead.create', savedLead);
```

Add immediately after:
```javascript
        that.checkContactsQuota(id_project).then(quota => {
          if (!quota.allowed) {
            leadEvent.emit('lead.quota.exceeded', { projectId: id_project, current: quota.current, limit: quota.limit });
          }
        }).catch(() => {});
```

- [ ] **Step 4: Add soft limit check inside updateWitId**

In the `updateWitId` method (line 115), after the `findOneAndUpdate` callback resolves (around line 144 where it emits `lead.update`), add:

Find this block:
```javascript
        leadEvent.emit('lead.update', updatedLead);
```

Add immediately after:
```javascript
        if (updatedLead && updatedLead.isNew !== false) {
          that.checkContactsQuota(id_project).then(quota => {
            if (!quota.allowed) {
              leadEvent.emit('lead.quota.exceeded', { projectId: id_project, current: quota.current, limit: quota.limit });
            }
          }).catch(() => {});
        }
```

Note: `updateWitId` uses `upsert: true` so it can create new leads. The soft limit notifies the owner but never blocks the creation.

- [ ] **Step 5: Commit**

```bash
git add services/leadService.js
git commit -m "feat: add checkContactsQuota with soft limit notifications"
```

---

### Task 8: Add hard limit check in routes/lead.js

**Files:**
- Modify: `C:\Users\enzo\tiledesk-server\routes\lead.js:14-23`

- [ ] **Step 1: Add hard limit check before lead creation in POST handler**

In `routes/lead.js`, the POST `/` handler starts at line 14. The handler calls `leadService.createWitId(...)` at line 19. Add the quota check before the creation call.

Find this block (around line 14-19):
```javascript
router.post('/', function (req, res) {
```

Replace the entire POST handler with:

```javascript
router.post('/', async function (req, res) {
  try {
    var leadService = req.app.get('leadService');

    var quota = await leadService.checkContactsQuota(req.projectid);
    if (!quota.allowed) {
      return res.status(403).json({
        error: 'contacts_limit_reached',
        message: 'Contact limit reached for your plan',
        limit: quota.limit,
        current: quota.current
      });
    }

    var savedLead = await leadService.createWitId(
      req.body.lead_id,
      req.body.fullname,
      req.body.email,
      req.projectid,
      req.user.id,
      req.body.attributes,
      undefined,
      req.body.phone
    );

    res.json(savedLead);
  } catch (err) {
    winston.error('Error creating lead', err);
    res.status(500).json({ error: 'Error creating lead' });
  }
});
```

Note: The original handler was callback-based. This converts it to async/await for cleaner quota check flow. `leadService` is retrieved from `req.app` (set during server boot via `app.set('leadService', leadService)`).

- [ ] **Step 2: Verify leadService is available via req.app**

Search for where leadService is set on the app:

```bash
grep -rn "app.set.*leadService\|app.get.*leadService" C:\Users\enzo\tiledesk-server/ --include="*.js" | head -5
```

If not found, it may be available via `require` directly. In that case, add at the top of `routes/lead.js`:

```javascript
var leadService = require('../services/leadService');
```

And use `leadService` directly instead of `req.app.get('leadService')`.

- [ ] **Step 3: Test hard limit**

```bash
curl -X POST http://localhost:3000/api/<project-id>/leads \
  -H "Authorization: JWT <your-token>" \
  -H "Content-Type: application/json" \
  -d '{"fullname":"Test Contact","email":"redacted@example.invalid"}'
```

Expected: 200 if under limit. For a free plan project with 200+ contacts, should return 403 with `contacts_limit_reached`.

- [ ] **Step 4: Commit**

```bash
git add routes/lead.js
git commit -m "feat: hard limit check for contacts quota in lead creation"
```

---

### Task 9: Add platforms quota check in routes/integration.js

**Files:**
- Modify: `C:\Users\enzo\tiledesk-server\routes\integration.js:80-109`

- [ ] **Step 1: Add channel names constant and quota check before the upsert**

At the top of `routes/integration.js`, after existing requires, add:

```javascript
var Integration = require('../models/integrations');
```

(Check if it's already imported — it likely is since the file manages integrations.)

Find the POST handler (line 80). Before the `Integration.findOneAndUpdate` call (line 94), add the platforms quota check:

```javascript
router.post('/', async function (req, res) {
  var CHANNEL_NAMES = ['whatsapp', 'telegram', 'messenger', 'sms', 'voice', 'voice_twilio'];
  var id_project = req.projectid;
  var name = req.body.name;

  if (CHANNEL_NAMES.includes(name)) {
    var existing = await Integration.findOne({ id_project: id_project, name: name });
    if (!existing) {
      var platformsCount = await Integration.countDocuments({ id_project: id_project, name: { $in: CHANNEL_NAMES } });
      var platformsLimit = (req.project && req.project.profile && req.project.profile.quotes && req.project.profile.quotes.platforms) || 1;
      if (platformsCount >= platformsLimit) {
        return res.status(403).json({
          error: 'platforms_limit_reached',
          message: 'Platform limit reached for your plan',
          limit: platformsLimit,
          current: platformsCount
        });
      }
    }
  }
```

Then continue with the existing `findOneAndUpdate` logic. The key insight: only check quota for NEW channel integrations (not updates to existing ones).

- [ ] **Step 2: Verify integration routes work normally**

```bash
curl -X POST http://localhost:3000/api/<project-id>/integration \
  -H "Authorization: JWT <your-token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"webhook","value":{"url":"https://example.com"}}'
```

Expected: 200 (webhook is not a channel, no quota check applies).

- [ ] **Step 3: Commit**

```bash
git add routes/integration.js
git commit -m "feat: platforms quota check for new channel integrations"
```

---

### Task 10: Add members quota check in routes/project_user.js

**Files:**
- Modify: `C:\Users\enzo\tiledesk-server\routes\project_user.js:22-54`

- [ ] **Step 1: Add members count check at the start of the invite handler**

In `routes/project_user.js`, the POST `/invite` handler starts at line 22. After the middleware chain and before `User.findOne` (line 34), add the quota check:

```javascript
    var Project_user = require('../models/project_user');
```

(Check if already imported at the top of the file.)

Inside the handler, early (around line 26, after extracting `id_project`), add:

```javascript
    var agentsLimit = (req.project && req.project.profile) ? req.project.profile.agents : 1;
    var activeCount = await Project_user.countDocuments({ id_project: req.projectid, status: 'active' });
    if (activeCount >= agentsLimit) {
      return res.status(403).json({
        error: 'members_limit_reached',
        message: 'Member limit reached for your plan',
        limit: agentsLimit,
        current: activeCount
      });
    }
```

Note: The existing handler may be callback-based. If so, convert the handler to `async function` to use `await`.

- [ ] **Step 2: Test invite with limit**

```bash
curl -X POST http://localhost:3000/api/<project-id>/project_users/invite \
  -H "Authorization: JWT <your-token>" \
  -H "Content-Type: application/json" \
  -d '{"email":"redacted@example.invalid","role":"agent"}'
```

Expected: 200 if under limit. 403 `members_limit_reached` if at limit.

- [ ] **Step 3: Commit**

```bash
git add routes/project_user.js
git commit -m "feat: members quota check on invite endpoint"
```

---

## Phase 3: Dashboard Pricing Page

### Task 11: Create casepay.service.ts

**Files:**
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\services\casepay.service.ts`
- Modify: `C:\Users\enzo\tiledesk-dashboard\src\app\app.module.ts`

- [ ] **Step 1: Create the service file**

Create `src/app/services/casepay.service.ts`:

```typescript
import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AuthService } from '../core/auth.service';
import { AppConfigService } from './app-config.service';
import { LoggerService } from './logger/logger.service';

@Injectable()
export class CasepayService {

  private SERVER_BASE_PATH: string;
  private TOKEN: string;

  constructor(
    private http: HttpClient,
    private auth: AuthService,
    private appConfig: AppConfigService,
    private logger: LoggerService,
  ) {
    this.SERVER_BASE_PATH = this.appConfig.getConfig().SERVER_BASE_URL;
    this.auth.user_bs.subscribe(user => {
      if (user) {
        this.TOKEN = user.token;
      }
    });
  }

  private getHeaders(): HttpHeaders {
    return new HttpHeaders({
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': this.TOKEN
    });
  }

  getPlans(): Observable<any[]> {
    const url = this.SERVER_BASE_PATH + 'modules/payments/casepay/plans';
    this.logger.log('[CASEPAY] GET plans', url);
    return this.http.get<any[]>(url, { headers: this.getHeaders() });
  }

  subscribe(projectId: string, planKey: string, billingPeriod: 'monthly' | 'annual'): Observable<any> {
    const url = this.SERVER_BASE_PATH + 'modules/payments/casepay/subscribe';
    this.logger.log('[CASEPAY] POST subscribe', url);
    return this.http.post<any>(url, { projectId, planKey, billingPeriod }, { headers: this.getHeaders() });
  }

  cancel(projectId: string): Observable<any> {
    const url = this.SERVER_BASE_PATH + 'modules/payments/casepay/cancel';
    this.logger.log('[CASEPAY] POST cancel', url);
    return this.http.post<any>(url, { projectId }, { headers: this.getHeaders() });
  }

  getStatus(projectId: string): Observable<any> {
    const url = this.SERVER_BASE_PATH + 'modules/payments/casepay/status/' + projectId;
    this.logger.log('[CASEPAY] GET status', url);
    return this.http.get<any>(url, { headers: this.getHeaders() });
  }

  getHistory(projectId: string): Observable<any[]> {
    const url = this.SERVER_BASE_PATH + 'modules/payments/casepay/history/' + projectId;
    this.logger.log('[CASEPAY] GET history', url);
    return this.http.get<any[]>(url, { headers: this.getHeaders() });
  }
}
```

- [ ] **Step 2: Register CasepayService in app.module.ts providers**

In `src/app/app.module.ts`, add the import at the top:

```typescript
import { CasepayService } from './services/casepay.service';
```

Add `CasepayService` to the `providers` array, after `ProjectPlanService` (around line 854):

```typescript
    ProjectPlanService,
    CasepayService,
```

- [ ] **Step 3: Verify the dashboard compiles**

```bash
cd C:\Users\enzo\tiledesk-dashboard
ng build --configuration development 2>&1 | tail -5
```

Expected: Build succeeds (or only unrelated warnings).

- [ ] **Step 4: Commit**

```bash
git add src/app/services/casepay.service.ts src/app/app.module.ts
git commit -m "feat: create CasepayService for billing API calls"
```

---

### Task 12: Create casepay-pricing module and component

**Files:**
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\casepay-pricing\casepay-pricing.module.ts`
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\casepay-pricing\casepay-pricing.component.ts`
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\casepay-pricing\casepay-pricing.component.html`
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\casepay-pricing\casepay-pricing.component.scss`

- [ ] **Step 1: Create the module**

Create `src/app/casepay-pricing/casepay-pricing.module.ts`:

```typescript
import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule, Routes } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { CasepayPricingComponent } from './casepay-pricing.component';

const routes: Routes = [
  { path: '', component: CasepayPricingComponent }
];

@NgModule({
  declarations: [CasepayPricingComponent],
  imports: [
    CommonModule,
    FormsModule,
    TranslateModule,
    RouterModule.forChild(routes)
  ]
})
export class CasepayPricingModule { }
```

- [ ] **Step 2: Create the component TypeScript**

Create `src/app/casepay-pricing/casepay-pricing.component.ts`:

```typescript
import { Component, OnInit, OnDestroy } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { Subscription, timer } from 'rxjs';
import { switchMap, takeWhile } from 'rxjs/operators';
import { CasepayService } from '../services/casepay.service';
import { ProjectPlanService } from '../services/project-plan.service';
import { AuthService } from '../core/auth.service';
import { LoggerService } from '../services/logger/logger.service';
import { BrandService } from '../services/brand.service';

@Component({
  selector: 'casepay-pricing',
  templateUrl: './casepay-pricing.component.html',
  styleUrls: ['./casepay-pricing.component.scss']
})
export class CasepayPricingComponent implements OnInit, OnDestroy {

  plans: any[] = [];
  projectStatus: any = null;
  isLoading = true;
  isSubscribing = false;
  isCanceling = false;
  isPolling = false;
  annualBilling = false;
  userRole: string;
  projectId: string;
  trialExpired = false;
  trialDaysLeft = 0;
  isTrialing = false;
  currentPlanKey: string;
  errorMessage: string;

  private subscriptions: Subscription[] = [];

  scaleWhatsAppLink = 'https://wa.me/5511999999999?text=';

  constructor(
    private casepayService: CasepayService,
    private projectPlanService: ProjectPlanService,
    private auth: AuthService,
    private router: Router,
    private route: ActivatedRoute,
    private logger: LoggerService,
    public brandService: BrandService,
  ) { }

  ngOnInit() {
    this.route.params.subscribe(params => {
      this.projectId = params['projectid'];
    });

    const planSub = this.projectPlanService.projectPlan$.subscribe(plan => {
      if (plan) {
        this.userRole = plan['user_role'];
        this.trialExpired = plan['trial_expired'];
        this.trialDaysLeft = plan['trial_days_left'];
        this.currentPlanKey = (plan['profile_name'] || 'Free').toLowerCase();
        this.isTrialing = this.trialDaysLeft > 0 && plan['profile_type'] !== 'payment';

        if (this.router.url.includes('/pricing/te')) {
          this.trialExpired = true;
        }
      }
    });
    this.subscriptions.push(planSub);

    this.loadData();
  }

  ngOnDestroy() {
    this.subscriptions.forEach(s => s.unsubscribe());
  }

  loadData() {
    this.isLoading = true;
    this.casepayService.getPlans().subscribe(
      plans => {
        this.plans = plans.filter(p => p.key !== 'free').concat([]);
        this.plans.unshift(plans.find(p => p.key === 'free'));
        this.loadStatus();
      },
      err => {
        this.logger.error('[CASEPAY-PRICING] Error loading plans', err);
        this.errorMessage = 'Erro ao carregar planos. Tente novamente.';
        this.isLoading = false;
      }
    );
  }

  loadStatus() {
    if (!this.projectId) { this.isLoading = false; return; }
    this.casepayService.getStatus(this.projectId).subscribe(
      status => {
        this.projectStatus = status;
        this.isLoading = false;
      },
      err => {
        this.logger.error('[CASEPAY-PRICING] Error loading status', err);
        this.isLoading = false;
      }
    );
  }

  getPrice(plan: any): number {
    if (plan.type === 'free') return 0;
    return this.annualBilling ? plan.annualPrice : plan.monthlyPrice;
  }

  getMonthlyEquivalent(plan: any): number {
    if (plan.type === 'free') return 0;
    return this.annualBilling ? +(plan.annualPrice / 12).toFixed(2) : plan.monthlyPrice;
  }

  isCurrentPlan(plan: any): boolean {
    if (!this.projectStatus) return false;
    return this.projectStatus.plan && this.projectStatus.plan.toLowerCase() === plan.name.toLowerCase();
  }

  canSubscribe(plan: any): boolean {
    if (this.userRole !== 'owner') return false;
    if (plan.type === 'free') return false;
    if (this.isCurrentPlan(plan) && !this.isTrialing) return false;
    return true;
  }

  subscribePlan(plan: any) {
    if (this.isSubscribing) return;
    this.isSubscribing = true;
    this.errorMessage = null;
    const period = this.annualBilling ? 'annual' : 'monthly';

    this.casepayService.subscribe(this.projectId, plan.key, period).subscribe(
      result => {
        if (result.authorizeUrl) {
          window.open(result.authorizeUrl, '_blank');
          this.startPolling();
        }
      },
      err => {
        this.isSubscribing = false;
        if (err.status === 403 && err.error && err.error.error === 'email_not_verified') {
          this.router.navigate(['/verify-email-waiting']);
        } else {
          this.errorMessage = 'Erro ao processar. Tente novamente.';
        }
      }
    );
  }

  startPolling() {
    this.isPolling = true;
    const pollSub = timer(0, 5000).pipe(
      switchMap(() => this.casepayService.getStatus(this.projectId)),
      takeWhile(status => {
        if (status.mandateStatus === 'active' || status.mandateStatus === 'AUTHORIZED') {
          this.isPolling = false;
          this.isSubscribing = false;
          this.projectStatus = status;
          this.loadStatus();
          return false;
        }
        return true;
      })
    ).subscribe();
    this.subscriptions.push(pollSub);

    setTimeout(() => {
      if (this.isPolling) {
        this.isPolling = false;
        this.isSubscribing = false;
        pollSub.unsubscribe();
      }
    }, 300000);
  }

  checkPayment() {
    this.loadStatus();
  }

  cancelSubscription() {
    if (this.isCanceling) return;
    this.isCanceling = true;
    this.casepayService.cancel(this.projectId).subscribe(
      () => {
        this.isCanceling = false;
        this.loadStatus();
      },
      err => {
        this.isCanceling = false;
        this.errorMessage = 'Erro ao cancelar. Tente novamente.';
      }
    );
  }

  isOwner(): boolean {
    return this.userRole === 'owner';
  }

  getFeatureList(plan: any): string[] {
    const features: string[] = [];
    features.push(plan.agents + (plan.agents === 1 ? ' agente' : ' agentes'));
    if (plan.quotes) {
      features.push((plan.quotes.contacts || 0).toLocaleString('pt-BR') + ' contatos');
      features.push((plan.quotes.platforms || 0) + (plan.quotes.platforms === 1 ? ' plataforma' : ' plataformas'));
      features.push((plan.quotes.chatbots || 0) + ' chatbots');
    }
    if (plan.customization) {
      if (plan.customization.whatsapp) features.push('WhatsApp');
      if (plan.customization.telegram) features.push('Telegram');
      if (plan.customization.copilot) features.push('Copilot IA');
      if (plan.customization.webhook) features.push('Webhooks');
      if (plan.customization.widgetUnbranding) features.push('Widget sem marca');
      if (plan.customization.smtpSettings) features.push('SMTP customizado');
    }
    return features;
  }
}
```

- [ ] **Step 3: Create the component HTML template**

Create `src/app/casepay-pricing/casepay-pricing.component.html`:

```html
<div class="pricing-container">

  <div *ngIf="trialExpired" class="trial-banner trial-expired">
    Seu período de teste expirou. Escolha um plano para continuar.
  </div>

  <div *ngIf="isTrialing && !trialExpired" class="trial-banner trial-active">
    Você está no período de teste Pro. Restam {{ trialDaysLeft }} dias.
  </div>

  <div class="pricing-header">
    <h2>Escolha seu plano</h2>
    <div class="billing-toggle">
      <span [class.active]="!annualBilling" (click)="annualBilling = false">Mensal</span>
      <label class="switch">
        <input type="checkbox" [(ngModel)]="annualBilling">
        <span class="slider"></span>
      </label>
      <span [class.active]="annualBilling" (click)="annualBilling = true">
        Anual <span class="discount-badge">-15%</span>
      </span>
    </div>
  </div>

  <div *ngIf="isLoading" class="skeleton-cards">
    <div class="skeleton-card" *ngFor="let i of [1,2,3,4,5]"></div>
  </div>

  <div *ngIf="errorMessage && !isLoading" class="error-banner">
    {{ errorMessage }}
    <button (click)="loadData()">Tentar novamente</button>
  </div>

  <div class="plans-grid" *ngIf="!isLoading && plans.length > 0">

    <div *ngFor="let plan of plans"
         class="plan-card"
         [class.recommended]="plan.key === 'pro'"
         [class.current-plan]="isCurrentPlan(plan) && !isTrialing">

      <div class="plan-badge" *ngIf="plan.key === 'pro'">Recomendado</div>
      <div class="plan-badge current" *ngIf="isCurrentPlan(plan) && !isTrialing">Plano Atual</div>
      <div class="plan-badge trial" *ngIf="isCurrentPlan(plan) && isTrialing">Em teste</div>

      <h3>{{ plan.displayName || plan.name }}</h3>

      <div class="plan-price" *ngIf="plan.type !== 'free'">
        <span class="currency">R$</span>
        <span class="amount">{{ getMonthlyEquivalent(plan) | number:'1.0-0':'pt-BR' }}</span>
        <span class="period">/mês</span>
        <div class="annual-total" *ngIf="annualBilling">
          R$ {{ getPrice(plan) | number:'1.2-2':'pt-BR' }} /ano
        </div>
      </div>
      <div class="plan-price free" *ngIf="plan.type === 'free'">
        <span class="amount">Grátis</span>
      </div>

      <ul class="feature-list">
        <li *ngFor="let feature of getFeatureList(plan)">
          <i class="material-icons">check</i> {{ feature }}
        </li>
      </ul>

      <div class="plan-actions" *ngIf="plan.type !== 'free'">
        <button *ngIf="canSubscribe(plan) && isOwner()"
                class="btn-subscribe"
                [class.recommended-btn]="plan.key === 'pro'"
                [disabled]="isSubscribing"
                (click)="subscribePlan(plan)">
          <span *ngIf="!isSubscribing">{{ isCurrentPlan(plan) && isTrialing ? 'Assinar' : (projectStatus?.mandateId ? 'Upgrade' : 'Assinar') }}</span>
          <span *ngIf="isSubscribing" class="spinner"></span>
        </button>

        <span *ngIf="!isOwner()" class="contact-owner">Contate o proprietário do projeto</span>

        <a *ngIf="isCurrentPlan(plan) && !isTrialing && isOwner() && projectStatus?.mandateId"
           class="cancel-link"
           (click)="showCancelModal = true">
          Cancelar assinatura
        </a>
      </div>

      <div class="plan-actions" *ngIf="plan.type === 'free'">
        <span class="current-label" *ngIf="isCurrentPlan(plan) && !isTrialing">Plano Atual</span>
      </div>
    </div>

    <!-- Scale+ Card -->
    <div class="plan-card scale-plus">
      <h3>Scale+</h3>
      <div class="plan-price free">
        <span class="amount">Personalizado</span>
      </div>
      <ul class="feature-list">
        <li><i class="material-icons">check</i> Preços exclusivos</li>
        <li><i class="material-icons">check</i> Suporte dedicado</li>
        <li><i class="material-icons">check</i> Integrações personalizadas</li>
        <li><i class="material-icons">check</i> Consultoria</li>
      </ul>
      <div class="plan-actions">
        <a class="btn-subscribe scale-btn"
           [href]="scaleWhatsAppLink + 'Olá! Tenho interesse no plano Scale+ para o projeto ' + projectId"
           target="_blank">
          Fale com especialista
        </a>
      </div>
    </div>
  </div>

  <!-- Usage Bars -->
  <div class="usage-section" *ngIf="projectStatus?.usage && !isLoading">
    <h3>Uso atual</h3>
    <div class="usage-bars">
      <div class="usage-item">
        <span>Contatos</span>
        <div class="usage-bar">
          <div class="usage-fill"
               [style.width.%]="(projectStatus.usage.contacts.current / projectStatus.usage.contacts.limit) * 100"
               [class.warning]="(projectStatus.usage.contacts.current / projectStatus.usage.contacts.limit) >= 0.75"
               [class.danger]="(projectStatus.usage.contacts.current / projectStatus.usage.contacts.limit) >= 0.95">
          </div>
        </div>
        <span class="usage-label">{{ projectStatus.usage.contacts.current | number:'1.0-0':'pt-BR' }}/{{ projectStatus.usage.contacts.limit | number:'1.0-0':'pt-BR' }}</span>
      </div>
      <div class="usage-item">
        <span>Plataformas</span>
        <div class="usage-bar">
          <div class="usage-fill"
               [style.width.%]="(projectStatus.usage.platforms.current / projectStatus.usage.platforms.limit) * 100"
               [class.warning]="(projectStatus.usage.platforms.current / projectStatus.usage.platforms.limit) >= 0.75"
               [class.danger]="(projectStatus.usage.platforms.current / projectStatus.usage.platforms.limit) >= 0.95">
          </div>
        </div>
        <span class="usage-label">{{ projectStatus.usage.platforms.current }}/{{ projectStatus.usage.platforms.limit }}</span>
      </div>
      <div class="usage-item">
        <span>Membros</span>
        <div class="usage-bar">
          <div class="usage-fill"
               [style.width.%]="(projectStatus.usage.agents.current / projectStatus.usage.agents.limit) * 100"
               [class.warning]="(projectStatus.usage.agents.current / projectStatus.usage.agents.limit) >= 0.75"
               [class.danger]="(projectStatus.usage.agents.current / projectStatus.usage.agents.limit) >= 0.95">
          </div>
        </div>
        <span class="usage-label">{{ projectStatus.usage.agents.current }}/{{ projectStatus.usage.agents.limit }}</span>
      </div>
    </div>
  </div>

  <!-- Polling State -->
  <div *ngIf="isPolling" class="polling-overlay">
    <div class="polling-card">
      <div class="spinner-large"></div>
      <p>Aguardando autorização...</p>
      <button class="btn-check" (click)="checkPayment()">Verificar pagamento</button>
    </div>
  </div>

  <!-- Cancel Modal -->
  <div *ngIf="showCancelModal" class="modal-overlay" (click)="showCancelModal = false">
    <div class="modal-card" (click)="$event.stopPropagation()">
      <h3>Cancelar assinatura</h3>
      <p>Tem certeza? Seu plano será alterado para Iniciante.</p>
      <div class="modal-actions">
        <button class="btn-secondary" (click)="showCancelModal = false">Voltar</button>
        <button class="btn-danger" [disabled]="isCanceling" (click)="cancelSubscription(); showCancelModal = false">
          {{ isCanceling ? 'Cancelando...' : 'Confirmar cancelamento' }}
        </button>
      </div>
    </div>
  </div>
</div>
```

- [ ] **Step 4: Create the component SCSS**

Create `src/app/casepay-pricing/casepay-pricing.component.scss`:

```scss
.pricing-container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 32px 24px;
}

.trial-banner {
  text-align: center;
  padding: 12px;
  border-radius: 8px;
  margin-bottom: 24px;
  font-size: 14px;
  font-weight: 500;
  &.trial-expired { background: #fff3e0; color: #e65100; border: 1px solid #ffcc80; }
  &.trial-active { background: #e3f2fd; color: #1565c0; border: 1px solid #90caf9; }
}

.pricing-header {
  text-align: center;
  margin-bottom: 32px;
  h2 { font-size: 28px; font-weight: 700; color: #333; margin-bottom: 16px; }
}

.billing-toggle {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
  color: #666;
  span.active { color: #1e88e5; font-weight: 600; }
}

.switch {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
  input { opacity: 0; width: 0; height: 0; }
  .slider {
    position: absolute;
    cursor: pointer;
    inset: 0;
    background-color: #ccc;
    border-radius: 24px;
    transition: 0.3s;
    &::before {
      content: '';
      position: absolute;
      height: 18px;
      width: 18px;
      left: 3px;
      bottom: 3px;
      background-color: white;
      border-radius: 50%;
      transition: 0.3s;
    }
  }
  input:checked + .slider { background-color: #1e88e5; }
  input:checked + .slider::before { transform: translateX(20px); }
}

.discount-badge {
  background: #4caf50;
  color: white;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
}

.skeleton-cards {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 16px;
}

.skeleton-card {
  height: 400px;
  background: #f0f0f0;
  border-radius: 12px;
  animation: pulse 1.5s ease infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.error-banner {
  text-align: center;
  padding: 24px;
  background: #ffeef0;
  border-radius: 8px;
  color: #c62828;
  margin-bottom: 24px;
  button {
    margin-top: 12px;
    padding: 8px 16px;
    background: #c62828;
    color: white;
    border: none;
    border-radius: 6px;
    cursor: pointer;
  }
}

.plans-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 16px;
  margin-bottom: 32px;
}

.plan-card {
  background: white;
  border: 1px solid #e0e0e0;
  border-radius: 12px;
  padding: 24px 20px;
  display: flex;
  flex-direction: column;
  position: relative;
  transition: box-shadow 0.2s;
  &:hover { box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1); }
  &.recommended {
    border: 2px solid #1e88e5;
    box-shadow: 0 4px 16px rgba(30, 136, 229, 0.15);
  }
  h3 { font-size: 18px; font-weight: 700; color: #333; margin: 0 0 12px; }
}

.plan-badge {
  position: absolute;
  top: -12px;
  left: 50%;
  transform: translateX(-50%);
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  background: #1e88e5;
  color: white;
  &.current { background: #4caf50; }
  &.trial { background: #ff9800; }
}

.plan-price {
  margin-bottom: 16px;
  .currency { font-size: 16px; color: #666; vertical-align: super; }
  .amount { font-size: 36px; font-weight: 700; color: #333; }
  .period { font-size: 14px; color: #999; }
  &.free .amount { font-size: 28px; color: #4caf50; }
}

.annual-total {
  font-size: 12px;
  color: #999;
  margin-top: 4px;
}

.feature-list {
  list-style: none;
  padding: 0;
  margin: 0 0 16px;
  flex: 1;
  li {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 0;
    font-size: 13px;
    color: #555;
    i { font-size: 16px; color: #4caf50; }
  }
}

.plan-actions {
  margin-top: auto;
  text-align: center;
}

.btn-subscribe {
  width: 100%;
  padding: 10px 16px;
  border: 1px solid #1e88e5;
  background: white;
  color: #1e88e5;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  text-decoration: none;
  display: inline-block;
  &:hover { background: #1e88e5; color: white; }
  &.recommended-btn { background: #1e88e5; color: white; }
  &.recommended-btn:hover { background: #1565c0; }
  &.scale-btn { background: #333; color: white; border-color: #333; }
  &.scale-btn:hover { background: #555; }
  &:disabled { opacity: 0.5; cursor: not-allowed; }
}

.contact-owner {
  font-size: 13px;
  color: #999;
  font-style: italic;
}

.cancel-link {
  display: block;
  margin-top: 8px;
  font-size: 12px;
  color: #e53935;
  cursor: pointer;
  &:hover { text-decoration: underline; }
}

.current-label {
  font-size: 13px;
  color: #4caf50;
  font-weight: 500;
}

.usage-section {
  background: white;
  border: 1px solid #e0e0e0;
  border-radius: 12px;
  padding: 24px;
  h3 { font-size: 16px; font-weight: 600; margin: 0 0 16px; color: #333; }
}

.usage-bars { display: flex; gap: 24px; }

.usage-item {
  flex: 1;
  span:first-child { font-size: 13px; color: #666; display: block; margin-bottom: 6px; }
}

.usage-bar {
  height: 8px;
  background: #e0e0e0;
  border-radius: 4px;
  overflow: hidden;
}

.usage-fill {
  height: 100%;
  background: #4caf50;
  border-radius: 4px;
  transition: width 0.3s;
  &.warning { background: #ff9800; }
  &.danger { background: #e53935; }
}

.usage-label {
  font-size: 12px;
  color: #999;
  margin-top: 4px;
  display: block;
}

.polling-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.polling-card {
  background: white;
  padding: 32px;
  border-radius: 12px;
  text-align: center;
  p { margin: 16px 0; font-size: 16px; color: #333; }
}

.btn-check {
  padding: 8px 16px;
  border: 1px solid #1e88e5;
  background: white;
  color: #1e88e5;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
}

.spinner {
  display: inline-block;
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: white;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

.spinner-large {
  width: 40px;
  height: 40px;
  border: 3px solid #e0e0e0;
  border-top-color: #1e88e5;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin: 0 auto;
}

@keyframes spin { to { transform: rotate(360deg); } }

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.modal-card {
  background: white;
  padding: 24px;
  border-radius: 12px;
  max-width: 400px;
  width: 90%;
  h3 { margin: 0 0 12px; }
  p { color: #666; margin: 0 0 20px; }
}

.modal-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}

.btn-secondary {
  padding: 8px 16px;
  border: 1px solid #ccc;
  background: white;
  border-radius: 6px;
  cursor: pointer;
}

.btn-danger {
  padding: 8px 16px;
  border: none;
  background: #e53935;
  color: white;
  border-radius: 6px;
  cursor: pointer;
  &:disabled { opacity: 0.5; }
}

@media (max-width: 1024px) {
  .plans-grid { grid-template-columns: repeat(3, 1fr); }
  .skeleton-cards { grid-template-columns: repeat(3, 1fr); }
}

@media (max-width: 768px) {
  .plans-grid { grid-template-columns: 1fr; }
  .skeleton-cards { grid-template-columns: 1fr; }
  .usage-bars { flex-direction: column; }
}
```

- [ ] **Step 5: Add showCancelModal property to component**

The template uses `showCancelModal` but it's not declared in the component. Add to the component class properties:

```typescript
  showCancelModal = false;
```

- [ ] **Step 6: Verify the dashboard compiles**

```bash
cd C:\Users\enzo\tiledesk-dashboard
ng build --configuration development 2>&1 | tail -5
```

Expected: Build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/app/casepay-pricing/
git commit -m "feat: create casepay-pricing module with plan cards, toggle, usage bars, polling"
```

---

### Task 13: Swap pricing routes in app.routing.ts

**Files:**
- Modify: `C:\Users\enzo\tiledesk-dashboard\src\app\app.routing.ts:267-288`

- [ ] **Step 1: Replace all 3 PricingModule routes with CasepayPricingModule**

Find the 3 pricing routes (lines 267-288) and replace:

```typescript
  // Pricing
  {
    path: 'project/:projectid/pricing',
    loadChildren: () => import('app/pricing/pricing.module').then(m => m.PricingModule),
    canActivate: [AuthGuard, RoleGuard],
    data: [{ roles: ['owner'] }]
  },

  // Pricing  trial expired
  {
    path: 'project/:projectid/pricing/te',
    loadChildren: () => import('app/pricing/pricing.module').then(m => m.PricingModule),
    canActivate: [AuthGuard, RoleGuard],
    data: [{ roles: ['owner'] }]
  },

  // { path: 'project/:projectid/pricing', component: PricingComponent, canActivate: [AuthGuard] }, // now Lazy
  {
    path: 'project/:projectid/chat-pricing',
    loadChildren: () => import('app/pricing/pricing.module').then(m => m.PricingModule),
    canActivate: [AuthGuard, RoleGuard],
    data: [{ roles: ['owner'] }]
  },
```

With:

```typescript
  // Pricing (CasePay)
  {
    path: 'project/:projectid/pricing',
    loadChildren: () => import('app/casepay-pricing/casepay-pricing.module').then(m => m.CasepayPricingModule),
    canActivate: [AuthGuard],
  },

  // Pricing trial expired (CasePay)
  {
    path: 'project/:projectid/pricing/te',
    loadChildren: () => import('app/casepay-pricing/casepay-pricing.module').then(m => m.CasepayPricingModule),
    canActivate: [AuthGuard],
  },

  // Chat panel pricing (CasePay)
  {
    path: 'project/:projectid/chat-pricing',
    loadChildren: () => import('app/casepay-pricing/casepay-pricing.module').then(m => m.CasepayPricingModule),
    canActivate: [AuthGuard],
  },
```

Note: `RoleGuard` removed and `data` removed. Role check is done inside the component.

- [ ] **Step 2: Verify the dashboard compiles and serves**

```bash
cd C:\Users\enzo\tiledesk-dashboard
ng build --configuration development 2>&1 | tail -5
```

- [ ] **Step 3: Test in browser**

Navigate to `http://localhost:4200/#/project/<project-id>/pricing` and verify:
- Plan cards load with correct names (Iniciante, Standard, Pro, Enterprise, Scale+)
- Toggle switches between monthly/annual prices
- Pro card is highlighted with "Recomendado" badge
- Usage bars show current counts
- Subscribe button is clickable (for owners)

- [ ] **Step 4: Test /pricing/te route**

Navigate to `http://localhost:4200/#/project/<project-id>/pricing/te` and verify the trial-expired banner appears.

- [ ] **Step 5: Commit**

```bash
git add src/app/app.routing.ts
git commit -m "feat: swap 3 pricing routes to CasepayPricingModule, remove RoleGuard"
```

---

### Task 14: Docker rebuild and end-to-end test

**Files:**
- No file changes — this is a verification task

- [ ] **Step 1: Rebuild Docker containers**

```bash
cd C:\Users\enzo\tiledesk
docker compose up -d --build server dashboard
```

- [ ] **Step 2: Verify GET /plans returns new structure**

```bash
curl -s http://localhost:3000/api/modules/payments/casepay/plans | python -m json.tool
```

Expected: 4 plans with displayName, monthlyPrice, annualPrice, contacts in quotes.

- [ ] **Step 3: Verify pricing page loads in browser**

Navigate to pricing page, verify all cards render, toggle works, usage bars appear.

- [ ] **Step 4: Test subscribe flow end-to-end**

Click "Assinar" on a plan, verify CasePay authorization URL opens, polling starts.

- [ ] **Step 5: Verify quota enforcement**

Try to add a contact via API on a project that's at limit. Verify 403 response.

- [ ] **Step 6: Commit any fixes**

If any fixes were needed during testing, commit them.

---

## Self-Review

### Spec Coverage

| Spec Section | Task(s) | Covered? |
|---|---|---|
| Mapeamento de Planos | Task 1 | ✅ |
| Dashboard Architecture | Tasks 11-13 | ✅ |
| Server Architecture | Tasks 1-5 | ✅ |
| Rotas Stripe Legadas | N/A (kept as-is) | ✅ |
| GET /plans format | Task 1 (getAllPlans spreads new fields) | ✅ |
| UI Layout + Cards | Task 12 | ✅ |
| Features por Card | Task 12 (getFeatureList) | ✅ |
| Estados dos Cards | Task 12 | ✅ |
| Role visibility | Task 12 (isOwner check) | ✅ |
| /pricing/te detection | Task 12 (router.url check) | ✅ |
| Scale+ Card | Task 12 | ✅ |
| Subscribe flow | Tasks 3, 12 | ✅ |
| Error handling | Task 12 (403, toast, retry) | ✅ |
| Cancel flow | Tasks 3, 12 | ✅ |
| Upgrade flow | Task 3 (cancel old mandate) | ✅ |
| Billing anual | Tasks 3, 5 | ✅ |
| Contacts enforcement | Tasks 7, 8 | ✅ |
| Platforms enforcement | Task 9 | ✅ |
| Members enforcement | Task 10 | ✅ |
| PLANS_LIST sync | Task 6 | ✅ |
| Post-downgrade grandfathering | Tasks 7-10 (quota checks only block new creation) | ✅ |
| Profile.js billingPeriod | Task 2 | ✅ |
| Webhook billingPeriod subEnd | Task 5 | ✅ |
| Webhook eventId guard | Task 5 | ✅ |
| Status endpoint usage | Task 4 | ✅ |

### Placeholder Scan
No TBD, TODO, "fill in", "similar to Task N", or vague steps found.

### Type Consistency
- `billingPeriod`: consistently `'monthly' | 'annual'` across Tasks 2, 3, 5, 12
- `planKey`: consistently lowercase string matching plans.js keys (`free`, `starter`, `pro`, `business`)
- `displayName`: only in plans.js and UI rendering
- `checkContactsQuota()`: returns `{ allowed, current, limit, percent }` — used consistently in Tasks 7 and 8
