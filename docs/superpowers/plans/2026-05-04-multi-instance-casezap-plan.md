# Multi-Instance CaseZap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a project to have multiple CaseZap (UazApi WhatsApp) instances, each consuming 1 platform quota slot.

**Architecture:** Bifurcate the POST integration handler: PLATFORM_CHANNELS use `create()` (multi-instance), non-platform keeps `findOneAndUpdate` (single). CaseZap connector webhook URL changes from `/webhook/:project_id` to `/webhook/:integration_id`, with legacy fallback. Request model stores `integrationId` so outbound sender resolves the correct instance.

**Tech Stack:** Node.js, Express, Mongoose, Angular 14

**Spec:** `docs/superpowers/specs/2026-05-01-multi-instance-casezap-design.md`

---

## File Structure

### Modify (Server)
| File | Responsibility |
|---|---|
| `models/request.js` | Add `integrationId` field to schema |
| `services/requestService.js` | Add `integrationId` to destructuring + constructor |
| `routes/integration.js` | POST bifurcation, new GET instances, remove PUT upsert, intra-project duplicate check |
| `pubmodules/casezap/connector.js` | Webhook per integration_id, outbound by integrationId, Map rekey, legacy fallback |

### Modify (Dashboard)
| File | Responsibility |
|---|---|
| `src/app/services/integration.service.ts` | Add `updateIntegration()` + `getIntegrationInstances()` |
| `src/app/casezap/casezap.component.ts` | Rewrite: list + add/edit state management |
| `src/app/casezap/casezap.component.html` | Rewrite: instance cards + form |
| `src/app/casezap/casezap.component.scss` | Cards styling |
| `src/app/utils/util.ts` | Add CASEZAP to CHANNELS_NAME |

---

### Task 1: Request Model — Add `integrationId` Field

**Files:**
- Modify: `models/request.js`
- Modify: `services/requestService.js`

- [ ] **Step 1: Add `integrationId` to Request schema**

In `models/request.js`, add this field to the schema definition (after the `channel` field, around line 45):

```javascript
  integrationId: {
    type: Schema.Types.ObjectId,
    ref: 'integration'
  },
```

- [ ] **Step 2: Add `integrationId` to requestService destructuring**

In `services/requestService.js`, find the destructuring block (~line 468). Add `integrationId` to the list:

```javascript
let {
  request_id,
  project_user_id,
  lead_id,
  id_project,
  first_text,
  sourcePage,
  language,
  userAgent,
  status,
  attributes,
  subject,
  preflight,
  channel,
  location,
  participants = [],
  tags,
  notes,
  priority,
  auto_close,
  followers,
  contact,
  integrationId
} = request;
```

- [ ] **Step 3: Add `integrationId` to the `new Request({...})` constructor**

In `services/requestService.js`, find `const newRequest = new Request({` (~line 623). Add `integrationId` to the object:

```javascript
const newRequest = new Request({
  request_id,
  requester: project_user_id,
  lead: lead_id,
  first_text,
  subject,
  status,
  participants,
  participantsAgents,
  participantsBots,
  hasBot,
  department: dep_id,
  sourcePage,
  language,
  userAgent,
  assigned_at,
  attributes,
  id_project,
  createdBy,
  updatedBy: createdBy,
  preflight,
  channel,
  location,
  tags,
  notes,
  priority,
  auto_close,
  followers,
  createdAt,
  snapshot,
  contact,
  integrationId,
})
```

- [ ] **Step 4: Verify no errors**

```bash
cd C:\Users\enzo\tiledesk-server
node -e "require('./models/request')"
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add models/request.js services/requestService.js
git commit -m "feat(multi-instance): add integrationId field to Request model and requestService"
```

---

### Task 2: Integration Routes — POST Bifurcation + New Endpoints

**Files:**
- Modify: `routes/integration.js`

- [ ] **Step 1: Replace the POST handler with bifurcated logic**

In `routes/integration.js`, replace the entire `router.post('/', ...)` handler (from `router.post('/', async (req, res) => {` to the closing `})`) with:

```javascript
router.post('/', async (req, res) => {

    let id_project = req.projectid;
    winston.debug("Add new integration ", req.body);

    var CHANNEL_FLAG_MAP = { 'whatsapp': 'whatsapp', 'telegram': 'telegram', 'messenger': 'messanger', 'casezap': 'casezap' };

    if (PLATFORM_CHANNELS.includes(req.body.name)) {
        var flagName = CHANNEL_FLAG_MAP[req.body.name];
        if (flagName) {
            var customization = req.project && req.project.profile && req.project.profile.customization;
            if (customization && customization[flagName] === false) {
                return res.status(403).json({
                    error: 'channel_not_available',
                    message: 'Channel ' + req.body.name + ' is not available on your plan',
                    channel: req.body.name
                });
            }
        }

        try {
            let platformsCount = await Integration.countDocuments({ id_project: id_project, name: { $in: PLATFORM_CHANNELS } });
            let platformsLimit = (req.project && req.project.profile && req.project.profile.quotes && req.project.profile.quotes.platforms) || 1;
            if (platformsCount >= platformsLimit) {
                return res.status(403).json({
                    error: 'platforms_limit_reached',
                    message: 'Platform limit reached for your plan',
                    limit: platformsLimit,
                    current: platformsCount
                });
            }
        } catch (quotaErr) {
            winston.error("Error checking platforms quota", quotaErr);
            return res.status(500).json({ error: 'Error checking platform quota' });
        }

        if (req.body.name === 'casezap' && req.body.value && req.body.value.domain && req.body.value.token) {
            try {
                let intraDup = await Integration.findOne({
                    id_project: id_project,
                    name: 'casezap',
                    'value.domain': req.body.value.domain,
                    'value.token': req.body.value.token
                });
                if (intraDup) {
                    return res.status(409).json({
                        error: 'casezap_duplicate_instance_same_project',
                        message: 'This UazApi instance is already connected in this project'
                    });
                }

                let crossDup = await Integration.findOne({
                    name: 'casezap',
                    id_project: { $ne: id_project },
                    'value.domain': req.body.value.domain,
                    'value.token': req.body.value.token
                });
                if (crossDup) {
                    return res.status(409).json({
                        error: 'casezap_duplicate_instance',
                        message: 'This UazApi instance is already connected to another project'
                    });
                }
            } catch (dupErr) {
                winston.error('Error checking CaseZap duplicate', dupErr);
            }
        }

        let newIntegration = new Integration({
            id_project: id_project,
            name: req.body.name,
            value: req.body.value || {}
        });

        newIntegration.save(function(err, savedIntegration) {
            if (err) {
                winston.error("Error creating new integration ", err);
                return res.status(500).send({ success: false, err: err });
            }

            Integration.find({ id_project: id_project }, function(err, integrations) {
                if (!err) {
                    integrationEvent.emit('integration.update', integrations, id_project);
                }
            });

            res.status(200).send(sanitizeIntegration(savedIntegration));
        });

    } else {
        let newIntegration = {
            id_project: id_project,
            name: req.body.name
        };
        if (req.body.value) {
            newIntegration.value = req.body.value;
        }

        Integration.findOneAndUpdate({ id_project: id_project, name: req.body.name }, newIntegration, { new: true, upsert: true, setDefaultsOnInsert: false }, function(err, savedIntegration) {
            if (err) {
                winston.error("Error creating new integration ", err);
                return res.status(404).send({ success: false, err: err });
            }

            Integration.find({ id_project: id_project }, function(err, integrations) {
                if (!err) {
                    integrationEvent.emit('integration.update', integrations, id_project);
                }
            });

            res.status(200).send(sanitizeIntegration(savedIntegration));
        });
    }
})
```

- [ ] **Step 2: Remove `upsert: true` from PUT handler**

In the `router.put('/:integration_id', ...)` handler, change:

```javascript
Integration.findByIdAndUpdate(integration_id, update, { new: true, upsert: true }, (err, savedIntegration) => {
```

To:

```javascript
Integration.findByIdAndUpdate(integration_id, update, { new: true }, (err, savedIntegration) => {
```

- [ ] **Step 3: Add GET instances endpoint**

Add this new route AFTER the existing `GET /name/:integration_name` route and BEFORE the POST route:

```javascript
router.get('/name/:integration_name/instances', async (req, res) => {

    let id_project = req.projectid;
    let integration_name = req.params.integration_name;

    Integration.find({ id_project: id_project, name: integration_name }, (err, integrations) => {
        if (err) {
            winston.error("Error finding integrations by name: ", err);
            return res.status(500).send({ success: false, err: err });
        }
        res.status(200).send(sanitizeIntegrations(integrations));
    })
})
```

- [ ] **Step 4: Verify no syntax errors**

```bash
cd C:\Users\enzo\tiledesk-server
node -e "require('./routes/integration')"
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add routes/integration.js
git commit -m "feat(multi-instance): bifurcate POST for PLATFORM_CHANNELS, add GET instances, remove PUT upsert"
```

---

### Task 3: Connector — Webhook Routes + Inbound Multi-Instance

**Files:**
- Modify: `pubmodules/casezap/connector.js`

- [ ] **Step 1: Rewrite the webhook handler and add legacy fallback**

Replace the existing `router.post('/webhook/:project_id', ...)` handler with TWO routes. The full connector.js needs these changes:

**Replace the imports section** (add nothing new — passport/validtoken already imported).

**Replace the webhook route** (from `router.post('/webhook/:project_id'` to its closing `});`) with:

```javascript
async function handleWebhook(integration, req, res) {
  var projectId = integration.id_project;

  try {
    var body = req.body;
    if (!body || !body.EventType) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    if (body.EventType === 'connection') {
      var newStatus = (body.data && body.data.state === 'open') ? 'active' : 'disconnected';
      await Integration.findByIdAndUpdate(integration._id, { $set: { 'value.status': newStatus } });
      winston.info('CaseZap connection event: integration ' + integration._id + ' status=' + newStatus);
      return res.status(200).json({ success: true });
    }

    if (body.EventType === 'messages_update') {
      return res.status(200).json({ success: true });
    }

    if (body.EventType !== 'messages') {
      return res.status(200).json({ success: true });
    }

    var mapped = messageMapper.mapInbound(body);
    if (!mapped) {
      return res.status(200).json({ success: true, skipped: 'unmappable message type' });
    }

    if (mapped.fromMe) {
      return res.status(200).json({ success: true, skipped: 'fromMe' });
    }
    if (mapped.isGroup) {
      return res.status(200).json({ success: true, skipped: 'group message' });
    }

    if (processedMessages.has(mapped.messageId)) {
      return res.status(200).json({ success: true, deduplicated: true });
    }
    processedMessages.set(mapped.messageId, true);

    var integrationId = integration._id.toString();
    var leadId = 'casezap-' + integrationId + '-' + mapped.phone;
    var instanceLabel = (integration.value.instanceName || '') + ' (' + (integration.value.number || mapped.phone) + ')';

    var lead = await leadService.createIfNotExistsWithLeadId(
      leadId,
      mapped.fullname,
      null,
      projectId,
      leadId,
      null,
      null,
      mapped.phone
    );

    var existingRequest = await Request.findOne({
      id_project: projectId,
      'channel.name': ChannelConstants.CASEZAP,
      integrationId: integration._id,
      lead: lead._id,
      status: { $lt: 1000 }
    }).sort({ createdAt: -1 });

    var requestId;
    if (existingRequest) {
      requestId = existingRequest.request_id;
    } else {
      requestId = 'support-group-' + projectId + '-' + uuidv4();
      var defaultDept = await Department.findOne({ id_project: projectId, default: true });
      var newRequest = {
        request_id: requestId,
        id_project: projectId,
        lead_id: lead._id,
        lead: lead,
        first_text: mapped.text || '',
        departmentid: defaultDept ? defaultDept._id : undefined,
        integrationId: integration._id,
        channel: { name: ChannelConstants.CASEZAP },
        createdBy: leadId,
        attributes: {
          casezapPhone: mapped.phone,
          instanceLabel: instanceLabel
        }
      };
      await requestService.create(newRequest);
    }

    var senderFullname = mapped.fullname || mapped.phone;
    await messageService.send(
      leadId,
      senderFullname,
      requestId,
      mapped.text,
      projectId,
      leadId,
      { casezapMessageId: mapped.messageId },
      mapped.type,
      mapped.metadata,
      null
    );

    res.status(200).json({ success: true });

  } catch (err) {
    winston.error('CaseZap webhook error for integration ' + integration._id, err);
    res.status(500).json({ error: 'Internal error' });
  }
}

router.post('/webhook/:integration_id', async function(req, res) {
  if (!casezapEnabled) {
    return res.status(503).json({ error: 'CaseZap module disabled' });
  }
  var integrationId = req.params.integration_id;
  var secret = REDACTED_SECRET;

  try {
    var integration = await Integration.findById(integrationId);
    if (!integration || !integration.value || integration.value.webhookSecret !== secret) {
      winston.warn('CaseZap webhook: invalid secret for integration ' + integrationId);
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }
    await handleWebhook(integration, req, res);
  } catch (err) {
    winston.error('CaseZap webhook error', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/webhook/project/:project_id', async function(req, res) {
  if (!casezapEnabled) {
    return res.status(503).json({ error: 'CaseZap module disabled' });
  }
  var projectId = req.params.project_id;
  var secret = REDACTED_SECRET;

  winston.warn('CaseZap: legacy webhook route used for project ' + projectId + '. Migrate to /webhook/:integration_id');

  try {
    var integration = await Integration.findOne({ id_project: projectId, name: 'casezap' });
    if (!integration || !integration.value || integration.value.webhookSecret !== secret) {
      winston.warn('CaseZap webhook: invalid secret for project ' + projectId);
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }
    await handleWebhook(integration, req, res);
  } catch (err) {
    winston.error('CaseZap legacy webhook error', err);
    res.status(500).json({ error: 'Internal error' });
  }
});
```

- [ ] **Step 2: Verify no syntax errors**

```bash
cd C:\Users\enzo\tiledesk-server
node -e "require('./pubmodules/casezap/connector')"
```

- [ ] **Step 3: Commit**

```bash
git add pubmodules/casezap/connector.js
git commit -m "feat(multi-instance): webhook per integration_id with legacy project fallback"
```

---

### Task 4: Connector — Outbound Sender + Map Rekey + Register Route

**Files:**
- Modify: `pubmodules/casezap/connector.js`

- [ ] **Step 1: Replace `sendOutboundMessage` with multi-instance version**

Replace the existing `sendOutboundMessage` function with:

```javascript
async function sendOutboundMessage(message) {
  try {
    if (!message || !message.request) return;
    if (!message.request.channel || !message.request.channel.name) return;
    if (message.status !== MessageConstants.CHAT_MESSAGE_STATUS.SENDING) return;
    if (message.channel_type !== MessageConstants.CHANNEL_TYPE.GROUP) return;
    if (message.request.channel.name !== ChannelConstants.CASEZAP) return;

    var leadId = message.request.lead && message.request.lead.lead_id;
    if (message.sender === leadId) return;

    var projectId = message.id_project;
    var integrationId = message.request.integrationId;
    var integration;
    if (integrationId) {
      integration = await Integration.findById(integrationId);
    } else {
      integration = await Integration.findOne({ id_project: projectId, name: 'casezap' });
    }
    if (!integration || !integration.value) {
      winston.warn('CaseZap integration not found for outbound');
      return;
    }

    if (integration.value.status === 'disconnected') {
      winston.warn('CaseZap instance disconnected: ' + integration._id);
      return;
    }

    var phone;
    if (integrationId) {
      phone = leadId.split('-').pop();
    } else {
      phone = leadId.replace('casezap-', '');
    }

    var outbound = messageMapper.mapOutbound(message, phone);

    try {
      await sendToUazApi(integration.value.domain, integration.value.token, outbound.endpoint, outbound.body);
      winston.debug('CaseZap sent to ' + phone + ' via ' + outbound.endpoint);
    } catch (firstErr) {
      winston.warn('CaseZap send failed, retrying: ' + firstErr.message);
      await new Promise(function(resolve) { setTimeout(resolve, 2000); });
      try {
        await sendToUazApi(integration.value.domain, integration.value.token, outbound.endpoint, outbound.body);
      } catch (retryErr) {
        winston.error('CaseZap send failed after retry to ' + phone, retryErr);
      }
    }

  } catch (err) {
    winston.error('CaseZap outbound error', err);
  }
}
```

- [ ] **Step 2: Replace `loadExistingProjects` with multi-instance version**

```javascript
async function loadExistingProjects() {
  try {
    var integrations = await Integration.find({ name: 'casezap' });
    integrations.forEach(function(i) {
      if (i.value && i.value.domain && i.value.token) {
        casezapProjects.set(i._id.toString(), {
          projectId: i.id_project,
          domain: i.value.domain,
          token: i.value.token
        });
      }
    });
    winston.info('CaseZap loaded ' + casezapProjects.size + ' existing instances');
  } catch (err) {
    winston.warn('CaseZap failed to load existing instances: ' + err.message);
  }
}
```

- [ ] **Step 3: Replace `setupIntegrationListener` with multi-instance version**

```javascript
function setupIntegrationListener(baseUrl) {
  loadExistingProjects();
  integrationEvent.on('integration.update', function(integrations, projectId) {
    var czInstances = integrations.filter(function(i) { return i.name === 'casezap'; });
    var currentIds = new Set(czInstances.map(function(i) { return i._id.toString(); }));

    for (var [intId, data] of casezapProjects) {
      if (data.projectId === projectId && !currentIds.has(intId)) {
        cleanupWebhook(intId, data.domain, data.token, baseUrl);
        casezapProjects.delete(intId);
      }
    }

    czInstances.forEach(function(i) {
      if (i.value) {
        casezapProjects.set(i._id.toString(), {
          projectId: projectId,
          domain: i.value.domain,
          token: i.value.token
        });
      }
    });
  });
  winston.info('CaseZap integration listener registered');
}
```

- [ ] **Step 4: Replace `registerWebhook` to use integration._id in webhook URL**

```javascript
async function registerWebhook(integration, baseUrl) {
  var domain = integration.value.domain;
  var token = integration.value.token;
  var webhookSecret = REDACTED_SECRET || uuidv4();
  var webhookUrl = baseUrl + '/modules/casezap/webhook/' + integration._id + '?secret=' + webhookSecret;

  var body = {
    url: webhookUrl,
    enabled: true,
    events: ['messages', 'messages_update', 'connection'],
    excludeMessages: ['wasSentByApi', 'isGroupYes']
  };

  try {
    await axios.post(domain.replace(/\/$/, '') + '/webhook', body, {
      headers: { 'token': token, 'Content-Type': 'application/json' },
      timeout: 10000
    });

    await Integration.findByIdAndUpdate(integration._id, {
      $set: { 'value.webhookSecret': webhookSecret, 'value.status': 'active' }
    });

    casezapProjects.set(integration._id.toString(), {
      projectId: integration.id_project,
      domain: domain,
      token: token
    });

    winston.info('CaseZap webhook registered for integration ' + integration._id);
    return { success: true, webhookSecret: webhookSecret };
  } catch (err) {
    var status = err.response && err.response.status;
    if (status === 401) {
      throw new Error('Token de instancia invalido');
    } else if (status === 429) {
      throw new Error('Instancia UazApi indisponivel');
    } else {
      throw new Error('Nao foi possivel conectar ao dominio da API: ' + (err.message || ''));
    }
  }
}
```

- [ ] **Step 5: Replace `cleanupWebhook` to use integrationId**

```javascript
async function cleanupWebhook(integrationId, domain, token, baseUrl) {
  var webhookUrl = baseUrl + '/modules/casezap/webhook/' + integrationId;
  try {
    await axios.post(domain.replace(/\/$/, '') + '/webhook', {
      action: 'delete',
      url: webhookUrl
    }, {
      headers: { 'token': token, 'Content-Type': 'application/json' },
      timeout: 10000
    });
    winston.info('CaseZap webhook cleaned up for integration ' + integrationId);
  } catch (err) {
    winston.warn('CaseZap webhook cleanup failed: ' + err.message);
  }
}
```

- [ ] **Step 6: Replace `/register` route to use integration_id**

```javascript
router.post('/register/:integration_id', [passport.authenticate(['basic', 'jwt'], { session: false }), validtoken], async function(req, res) {
  var integrationId = req.params.integration_id;
  var externalUrl = process.env.EXTERNAL_BASE_URL || (req.protocol + '://' + req.get('host'));
  var baseUrl = externalUrl.replace(/\/+$/, '') + '/api';

  try {
    var integration = await Integration.findById(integrationId);
    if (!integration || !integration.value) {
      return res.status(404).json({ error: 'CaseZap integration not found' });
    }

    var result = await registerWebhook(integration, baseUrl);
    res.status(200).json(result);
  } catch (err) {
    winston.error('CaseZap register webhook error', err);
    res.status(502).json({ error: err.message });
  }
});
```

- [ ] **Step 7: Verify no syntax errors**

```bash
cd C:\Users\enzo\tiledesk-server
node -e "require('./pubmodules/casezap/connector')"
```

- [ ] **Step 8: Commit**

```bash
git add pubmodules/casezap/connector.js
git commit -m "feat(multi-instance): outbound by integrationId, Map rekey, register per integration"
```

---

### Task 5: Dashboard — IntegrationService Methods

**Files:**
- Modify: `C:\Users\enzo\tiledesk-dashboard\src\app\services\integration.service.ts`

- [ ] **Step 1: Add `updateIntegration` and `getIntegrationInstances` methods**

Add these two methods to the IntegrationService class, after the existing `deleteIntegration` method:

```typescript
  updateIntegration(integration_id: string, data: any) {
    const httpOptions = {
      headers: new HttpHeaders({
        'Content-Type': 'application/json',
        'Authorization': this.TOKEN
      })
    };
    const url = this.SERVER_BASE_PATH + this.project_id + '/integration/' + integration_id;
    return this.http.put(url, JSON.stringify(data), httpOptions);
  }

  getIntegrationInstances(name: string) {
    const httpOptions = {
      headers: new HttpHeaders({
        'Content-Type': 'application/json',
        'Authorization': this.TOKEN
      })
    };
    const url = this.SERVER_BASE_PATH + this.project_id + '/integration/name/' + name + '/instances';
    return this.http.get(url, httpOptions);
  }
```

- [ ] **Step 2: Commit**

```bash
cd C:\Users\enzo\tiledesk-dashboard
git add src/app/services/integration.service.ts
git commit -m "feat(multi-instance): add updateIntegration and getIntegrationInstances to IntegrationService"
```

---

### Task 6: Dashboard — CaseZap Multi-Instance Page Rewrite

**Files:**
- Modify: `C:\Users\enzo\tiledesk-dashboard\src\app\casezap\casezap.component.ts`
- Modify: `C:\Users\enzo\tiledesk-dashboard\src\app\casezap\casezap.component.html`
- Modify: `C:\Users\enzo\tiledesk-dashboard\src\app\casezap\casezap.component.scss`

This task requires a full rewrite of the CaseZap component. The subagent should read the current files first, then rewrite them following the spec's dashboard section. Key requirements:

- [ ] **Step 1: Rewrite casezap.component.ts**

The component must manage these states: `view: 'list' | 'add' | 'edit'`, an `instances[]` array loaded via `getIntegrationInstances('casezap')`, and an `editingInstance` for edit mode.

Key methods:
- `loadInstances()` — calls `integrationService.getIntegrationInstances('casezap')`
- `loadQuota()` — calls `integrationService.getAllIntegrations()` and counts PLATFORM_CHANNELS
- `addInstance()` — POST via `integrationService.saveIntegration({name:'casezap', value:{...}})`, then calls `registerWebhook(result._id)`
- `updateInstance()` — PUT via `integrationService.updateIntegration(id, {value:{...}})`, then calls `registerWebhook(id)`
- `removeInstance(id)` — DELETE via `integrationService.deleteIntegration(id)`
- `registerWebhook(integrationId)` — POST to `modules/casezap/register/:integrationId`

Use `auth.project_bs` for projectId, `auth.user_bs` for TOKEN (same pattern as current component). Unsubscribe in `ngOnDestroy`.

- [ ] **Step 2: Rewrite casezap.component.html**

Layout:
```html
<!-- Header -->
<div class="casezap-header">
  <svg>WhatsApp icon</svg>
  <h2>CaseZap</h2>
  <span>quota: {{ instances.length }} / {{ platformsLimit }}</span>
  <button (click)="view = 'add'" *ngIf="view === 'list'">+ Adicionar instancia</button>
</div>

<!-- List view -->
<div *ngIf="view === 'list'">
  <div *ngFor="let inst of instances" class="instance-card">
    <div class="instance-info">
      <strong>{{ inst.value?.instanceName }}</strong> ({{ inst.value?.number }})
      <span class="status-badge">{{ inst.value?.status }}</span>
    </div>
    <div class="instance-actions">
      <button (click)="startEdit(inst)">Editar</button>
      <button (click)="removeInstance(inst._id)">Remover</button>
    </div>
  </div>
</div>

<!-- Add/Edit form -->
<div *ngIf="view === 'add' || view === 'edit'" class="casezap-form">
  <!-- 4 fields: number, domain, token, instanceName -->
  <!-- Save/Cancel buttons -->
</div>
```

- [ ] **Step 3: Rewrite casezap.component.scss**

Instance card styles, status badge (green active / red disconnected), responsive layout. Follow the existing styling patterns from the current component.

- [ ] **Step 4: Build dashboard to verify**

```bash
cd C:\Users\enzo\tiledesk-dashboard
ng build --configuration=production 2>&1 | head -5
```

Expected: Build succeeds or only warnings.

- [ ] **Step 5: Commit**

```bash
cd C:\Users\enzo\tiledesk-dashboard
git add src/app/casezap/
git commit -m "feat(multi-instance): rewrite CaseZap page for multi-instance management"
```

---

### Task 7: Dashboard — Add CaseZap to CHANNELS_NAME + Conversation Display

**Files:**
- Modify: `C:\Users\enzo\tiledesk-dashboard\src\app\utils\util.ts`

- [ ] **Step 1: Add CASEZAP to CHANNELS_NAME**

In `src/app/utils/util.ts`, find the `CHANNELS_NAME` constant (~line 987) and add:

```typescript
export const CHANNELS_NAME = {
    CHAT21: 'chat21',
    EMAIL: 'email',
    FORM: 'form',
    TELEGRAM: 'telegram',
    MESSANGER: 'messenger',
    WHATSAPP: 'whatsapp',
    VOICE_VXML: 'voice-vxml',
    VOICE_TWILIO: 'voice_twilio',
    SMS_TWILIO: 'sms-twilio',
    CASEZAP: 'casezap',
}
```

- [ ] **Step 2: Commit**

```bash
cd C:\Users\enzo\tiledesk-dashboard
git add src/app/utils/util.ts
git commit -m "feat(multi-instance): add CASEZAP to CHANNELS_NAME constant"
```

---

### Task 8: E2E Verification

- [ ] **Step 1: Run messageMapper tests**

```bash
cd C:\Users\enzo\tiledesk-server
npx mocha test/casezap/messageMapper.test.js --exit
```

Expected: All tests pass.

- [ ] **Step 2: Rebuild Docker**

```bash
cd C:\Users\enzo\tiledesk
docker compose up -d --build server dashboard
```

- [ ] **Step 3: Verify server loads**

Check logs for:
```
CaseZap loaded N existing instances
CaseZap outbound listener registered
CaseZap integration listener registered
```

- [ ] **Step 4: Test multi-instance creation**

Create 2 CaseZap integrations for the same project via API. Verify both are created (not upserted). Verify quota counts correctly.

- [ ] **Step 5: Test webhook routing**

Send test webhook to `/modules/casezap/webhook/:integration_id?secret=X`. Verify it routes to the correct instance.

- [ ] **Step 6: Test legacy webhook fallback**

Send test webhook to `/modules/casezap/webhook/project/:project_id?secret=X`. Verify it still works with deprecation warning.

- [ ] **Step 7: Test outbound per instance**

Reply to a conversation. Verify the outbound message uses the correct instance credentials (not a random one).

- [ ] **Step 8: Test dashboard**

Navigate to `/casezap`. Verify instance list loads. Add a new instance. Edit an existing instance. Remove an instance.
