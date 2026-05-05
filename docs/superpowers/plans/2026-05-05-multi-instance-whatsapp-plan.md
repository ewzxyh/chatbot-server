# Multi-Instance WhatsApp Official (Meta) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Internalize the WhatsApp connector and enable multiple WhatsApp Business numbers per project.

**Architecture:** Copy the npm connector to `pubmodules/whatsapp/connector/`, then modify the kvstore lookup, outbound routing, OAuth callback, and configure template to support N instances per project. Dual-write to both kvstore (connector config) and integrations collection (quota/display).

**Tech Stack:** Node.js, Express, MongoDB raw driver (KVBaseMongo), Handlebars templates

**Spec:** `docs/superpowers/specs/2026-05-05-multi-instance-whatsapp-design.md`

---

## File Structure

### Create
| File | Responsibility |
|---|---|
| `pubmodules/whatsapp/connector/` | Full copy of `@tiledesk/tiledesk-whatsapp-connector` npm package |

### Modify
| File | Responsibility |
|---|---|
| `pubmodules/whatsapp/listener.js` | Change require to `./connector` |
| `pubmodules/whatsapp/index.js` | Change require to `./connector` |
| `pubmodules/whatsapp/connector/tiledesk/KVBaseMongo.js` | Add `getByField()` and `getAll()` |
| `pubmodules/whatsapp/connector/tiledesk/Utils.js` | Add `getSettingsByPhoneNumberId()` and `getAllSettingsByProjectId()`, fix `getSettings()` lookup order |
| `pubmodules/whatsapp/connector/index.js` | Fix outbound routing, dual-write in OAuth callback and /update, disconnect per waba_id, /configure multi-instance |
| `pubmodules/whatsapp/connector/tiledesk/TiledeskChannel.js` | Pass waba_id + phone_number_id in message attributes |
| `pubmodules/whatsapp/connector/template/configure.html` | Fix OAuth scopes (permanent, replaces Dockerfile sed) |
| `routes/integration.js` | Add WhatsApp duplicate detection by phone_number_id |
| `package.json` | Remove `@tiledesk/tiledesk-whatsapp-connector` |
| `Dockerfile` | Remove sed patch for scopes |

---

### Task 1: Internalize Connector — Copy npm package to local module

**Files:**
- Create: `pubmodules/whatsapp/connector/` (entire directory)
- Modify: `pubmodules/whatsapp/listener.js`
- Modify: `pubmodules/whatsapp/index.js`

- [ ] **Step 1: Copy the npm connector to local directory**

```bash
cd C:\Users\enzo\tiledesk-server
cp -r node_modules/@tiledesk/tiledesk-whatsapp-connector pubmodules/whatsapp/connector
```

Remove the nested node_modules test artifacts but KEEP the connector's own dependencies:
```bash
rm -rf pubmodules/whatsapp/connector/.git
rm -rf pubmodules/whatsapp/connector/test
rm -f pubmodules/whatsapp/connector/publish.sh
```

- [ ] **Step 2: Fix OAuth scopes permanently in configure.html**

In `pubmodules/whatsapp/connector/template/configure.html`, find line ~643:
```javascript
scope: 'whatsapp_business_management,business_management,pages_show_list',
```
Replace with:
```javascript
scope: 'whatsapp_business_management,whatsapp_business_messaging',
```

- [ ] **Step 3: Update listener.js to require local connector**

In `pubmodules/whatsapp/listener.js`, change line 1:
```javascript
// BEFORE:
const whatsapp = require("@tiledesk/tiledesk-whatsapp-connector");

// AFTER:
const whatsapp = require("./connector");
```

- [ ] **Step 4: Update index.js to require local connector**

In `pubmodules/whatsapp/index.js`, change:
```javascript
// BEFORE:
const whatsapp = require("@tiledesk/tiledesk-whatsapp-connector");

// AFTER:
const whatsapp = require("./connector");
```

- [ ] **Step 5: Remove npm dependency from package.json**

In `package.json`, remove the line:
```json
"@tiledesk/tiledesk-whatsapp-connector": "^1.0.26",
```

- [ ] **Step 6: Remove sed patch from Dockerfile**

In `Dockerfile`, remove the line:
```dockerfile
RUN sed -i "s/scope: 'whatsapp_business_management,business_management,pages_show_list'/scope: 'whatsapp_business_management,whatsapp_business_messaging'/" node_modules/@tiledesk/tiledesk-whatsapp-connector/template/configure.html || true
```

- [ ] **Step 7: Verify module loads**

```bash
cd C:\Users\enzo\tiledesk-server
node -e "require('./pubmodules/whatsapp')"
```

Expected: No MODULE_NOT_FOUND errors.

- [ ] **Step 8: Commit**

```bash
git add pubmodules/whatsapp/connector/ pubmodules/whatsapp/listener.js pubmodules/whatsapp/index.js package.json Dockerfile
git commit -m "feat(multi-instance-wa): internalize WhatsApp connector from npm to local module"
```

---

### Task 2: KVBaseMongo — Add getByField() and getAll()

**Files:**
- Modify: `pubmodules/whatsapp/connector/tiledesk/KVBaseMongo.js`

- [ ] **Step 1: Add getByField() method**

In `KVBaseMongo.js`, add this method to the class, after the existing `get()` method:

```javascript
  getByField(field, value) {
    return new Promise((resolve, reject) => {
      let query = {};
      query['value.' + field] = value;
      this.db.collection(this.KV_COLLECTION).findOne(query, function(err, doc) {
        if (err) { reject(err); }
        else {
          if (doc) { resolve(doc.value); }
          else { resolve(null); }
        }
      });
    });
  }
```

- [ ] **Step 2: Add getAll() method**

Add this method after `getByField()`:

```javascript
  getAll(value, field) {
    return new Promise((resolve, reject) => {
      let query = {};
      query[field] = value;
      this.db.collection(this.KV_COLLECTION).find(query).toArray(function(err, docs) {
        if (err) { reject(err); }
        else {
          resolve(docs.map(function(d) { return d.value; }));
        }
      });
    });
  }
```

- [ ] **Step 3: Commit**

```bash
git add pubmodules/whatsapp/connector/tiledesk/KVBaseMongo.js
git commit -m "feat(multi-instance-wa): add getByField and getAll to KVBaseMongo"
```

---

### Task 3: Utils.js — Add multi-instance lookup functions + fix getSettings order

**Files:**
- Modify: `pubmodules/whatsapp/connector/tiledesk/Utils.js`

- [ ] **Step 1: Fix getSettings() lookup order — waba_id first**

In `Utils.js`, replace the `getSettings` method:

```javascript
// BEFORE:
async getSettings(project_id, waba_id) {
    let CONTENT_KEY = "whatsapp-" + project_id;
    let settings;
    settings = await this.db.get(CONTENT_KEY);
    if (!settings) {
      CONTENT_KEY = "whatsapp-" + waba_id;
      settings = await this.db.get(CONTENT_KEY);
    }
    return settings;
}

// AFTER:
async getSettings(project_id, waba_id) {
    if (waba_id) {
      let settings = await this.db.get('whatsapp-' + waba_id);
      if (settings) return settings;
    }
    return await this.db.get('whatsapp-' + project_id);
}
```

- [ ] **Step 2: Add getSettingsByPhoneNumberId()**

Add this method after `getSettingsByProjectId()`:

```javascript
async getSettingsByPhoneNumberId(phone_number_id) {
    try {
        return await this.db.getByField('phone_number_id', phone_number_id);
    } catch(err) {
        return null;
    }
}
```

- [ ] **Step 3: Add getAllSettingsByProjectId()**

Add this method after `getSettingsByPhoneNumberId()`:

```javascript
async getAllSettingsByProjectId(project_id) {
    try {
        return await this.db.getAll(project_id, 'project_id');
    } catch(err) {
        return [];
    }
}
```

- [ ] **Step 4: Commit**

```bash
git add pubmodules/whatsapp/connector/tiledesk/Utils.js
git commit -m "feat(multi-instance-wa): add getSettingsByPhoneNumberId, getAllSettingsByProjectId, fix getSettings lookup order"
```

---

### Task 4: Outbound Fix — Lookup by phone_number_id

**Files:**
- Modify: `pubmodules/whatsapp/connector/index.js`

- [ ] **Step 1: Fix the POST /tiledesk handler**

In `pubmodules/whatsapp/connector/index.js`, find the `POST /tiledesk` route (~line 563). Replace the settings lookup block:

```javascript
// BEFORE (lines 573-577):
let settings = await utils.getSettingsByProjectId(project_id);
if (!settings) {
  settings = await utils.getSettings(project_id, waba_id);
}

// AFTER:
let phone_number_id_from_attrs = null;
if (req.body.payload.attributes && req.body.payload.attributes.whatsapp_phone_number_id) {
  phone_number_id_from_attrs = req.body.payload.attributes.whatsapp_phone_number_id;
}
let settings;
if (phone_number_id_from_attrs) {
  settings = await utils.getSettingsByPhoneNumberId(phone_number_id_from_attrs);
}
if (!settings) {
  settings = await utils.getSettingsByProjectId(project_id);
}
if (!settings) {
  settings = await utils.getSettings(project_id, waba_id);
}
```

- [ ] **Step 2: Fix the POST /tiledesk/broadcast handler**

Find the broadcast route (~line 1524). Replace the settings lookup:

```javascript
// BEFORE (line 1531):
let settings = await db.get("whatsapp-" + project_id);

// AFTER:
let broadcast_phone_number_id = req.body.phone_number_id;
let settings;
if (broadcast_phone_number_id) {
  settings = await utils.getSettingsByPhoneNumberId(broadcast_phone_number_id);
}
if (!settings) {
  settings = await db.get("whatsapp-" + project_id);
}
```

- [ ] **Step 3: Fix the GET /direct/tiledesk handler**

Find the direct route (~line 1473). Replace the settings lookup:

```javascript
// BEFORE (line 1480):
let settings = await db.get("whatsapp-" + project_id);

// AFTER:
let direct_phone_number_id = req.query.phone_number_id;
let settings;
if (direct_phone_number_id) {
  settings = await utils.getSettingsByPhoneNumberId(direct_phone_number_id);
}
if (!settings) {
  settings = await db.get("whatsapp-" + project_id);
}
```

- [ ] **Step 4: Commit**

```bash
git add pubmodules/whatsapp/connector/index.js
git commit -m "feat(multi-instance-wa): outbound routing by phone_number_id with fallback"
```

---

### Task 5: TiledeskChannel — Pass waba_id + phone_number_id in message attributes

**Files:**
- Modify: `pubmodules/whatsapp/connector/tiledesk/TiledeskChannel.js`

- [ ] **Step 1: Add waba_id and phone_number_id to send() method**

In `TiledeskChannel.js`, find the `send()` method (~line 54). After the `request_id` is determined and before the HTTP call, add attributes:

Find where `tiledeskMessage` is prepared for sending. In the `send()` method, after the channel info is extracted (~line 66), add:

```javascript
if (messageInfo.channel === "whatsapp" && messageInfo.whatsapp) {
  if (!tiledeskMessage.attributes) tiledeskMessage.attributes = {};
  tiledeskMessage.attributes.waba_id = messageInfo.whatsapp.waba_id || null;
  tiledeskMessage.attributes.whatsapp_phone_number_id = messageInfo.whatsapp.phone_number_id || null;
}
```

- [ ] **Step 2: Same for sendAndAddBot() method**

In the `sendAndAddBot()` method (~line 184), the attributes are hardcoded to `{ sourcePage: "whatsapp://..." }`. Change to:

```javascript
tiledeskMessage.attributes = {
  sourcePage: "whatsapp://&td_draft=true",
  waba_id: messageInfo.whatsapp ? messageInfo.whatsapp.waba_id : null,
  whatsapp_phone_number_id: messageInfo.whatsapp ? messageInfo.whatsapp.phone_number_id : null
};
```

- [ ] **Step 3: Verify waba_id is available in messageInfo**

In `index.js`, find the webhook handler where `messageInfo` is constructed (~line 831-838). Verify that `messageInfo.whatsapp` contains `waba_id`. If not, add it:

```javascript
// In the webhook handler, where messageInfo.whatsapp is built:
messageInfo.whatsapp = {
  phone_number_id: phone_number_id,
  from: from,
  waba_id: waba_id  // ADD THIS if not present
};
```

- [ ] **Step 4: Commit**

```bash
git add pubmodules/whatsapp/connector/tiledesk/TiledeskChannel.js pubmodules/whatsapp/connector/index.js
git commit -m "feat(multi-instance-wa): pass waba_id and phone_number_id in message attributes"
```

---

### Task 6: Dual-Write — OAuth callback + manual config to integrations collection

**Files:**
- Modify: `pubmodules/whatsapp/connector/index.js`

- [ ] **Step 1: Add dual-write in OAuth /onboarding/callback**

In `index.js`, find the `/onboarding/callback` route (~line 227). After `await db.set(CONTENT_KEY, settings);`, add:

```javascript
// Dual-write to integrations collection
try {
  await axios.post(API_URL + '/' + settings.project_id + '/integration', {
    name: 'whatsapp',
    value: {
      phone_number_id: settings.phone_number_id,
      waba_id: settings.waba_id,
      phone_number: settings.phone_number,
      verified_name: settings.verified_name
    }
  }, {
    headers: { 'Authorization': 'JWT ' + settings.token }
  });
} catch(intErr) {
  winston.error("(wab) Error creating integration document: " + intErr.message);
}
```

- [ ] **Step 2: Add dual-write in POST /update (manual config)**

In `index.js`, find the `POST /update` route (~line 329). After `await db.set(CONTENT_KEY, settings);` (~line 358), add:

```javascript
// Dual-write to integrations collection
try {
  await axios.post(API_URL + '/' + project_id + '/integration', {
    name: 'whatsapp',
    value: {
      phone_number_id: settings.phone_number_id,
      waba_id: settings.business_account_id,
      phone_number: settings.phone_number,
      verified_name: settings.verified_name
    }
  }, {
    headers: { 'Authorization': 'JWT ' + token }
  });
} catch(intErr) {
  winston.error("(wab) Error creating integration document: " + intErr.message);
}
```

- [ ] **Step 3: Commit**

```bash
git add pubmodules/whatsapp/connector/index.js
git commit -m "feat(multi-instance-wa): dual-write OAuth and manual config to integrations collection"
```

---

### Task 7: Duplicate Detection + Disconnect per waba_id

**Files:**
- Modify: `routes/integration.js`
- Modify: `pubmodules/whatsapp/connector/index.js`

- [ ] **Step 1: Add WhatsApp duplicate detection in integration.js**

In `routes/integration.js`, inside the POST handler, after the CaseZap duplicate check block (~line 174), add:

```javascript
    if (req.body.name === 'whatsapp' && req.body.value && req.body.value.phone_number_id) {
        try {
            let waDup = await Integration.findOne({
                id_project: id_project,
                name: 'whatsapp',
                'value.phone_number_id': req.body.value.phone_number_id
            });
            if (waDup) {
                return res.status(409).json({
                    error: 'whatsapp_duplicate_number',
                    message: 'This WhatsApp number is already connected in this project'
                });
            }
        } catch (waDupErr) {
            winston.error('Error checking WhatsApp duplicate', waDupErr);
        }
    }
```

- [ ] **Step 2: Fix /disconnect route to accept waba_id**

In `pubmodules/whatsapp/connector/index.js`, find the `POST /disconnect` route. Modify to accept `waba_id` and delete the specific instance:

```javascript
// Find the disconnect handler and update to:
let waba_id = req.body.waba_id;
let project_id = req.body.project_id;

// Delete from kvstore
if (waba_id) {
  await db.remove('whatsapp-' + waba_id);
} else {
  await db.remove('whatsapp-' + project_id);
}

// Delete from integrations collection
if (waba_id) {
  try {
    // Find and delete the integration with this waba_id
    let integrations = await axios.get(API_URL + '/' + project_id + '/integration/name/whatsapp/instances', {
      headers: { 'Authorization': 'JWT ' + req.body.token }
    });
    let toDelete = integrations.data.find(i => i.value && i.value.waba_id === waba_id);
    if (toDelete) {
      await axios.delete(API_URL + '/' + project_id + '/integration/' + toDelete._id, {
        headers: { 'Authorization': 'JWT ' + req.body.token }
      });
    }
  } catch(delErr) {
    winston.error("(wab) Error deleting integration: " + delErr.message);
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add routes/integration.js pubmodules/whatsapp/connector/index.js
git commit -m "feat(multi-instance-wa): WhatsApp duplicate detection and per-instance disconnect"
```

---

### Task 8: Configure Route Multi-Instance + Legacy Deprecation Warning

**Files:**
- Modify: `pubmodules/whatsapp/connector/index.js`

- [ ] **Step 1: Update /configure route for multi-instance**

In `index.js`, find the `GET /configure` route (~line 95). Change the settings lookup to fetch all instances:

```javascript
// BEFORE:
let settings = await utils.getSettingsByProjectId(project_id);
// ... renders single instance

// AFTER:
let settings = await utils.getSettingsByProjectId(project_id);
let allInstances = await utils.getAllSettingsByProjectId(project_id);
```

Add `api_url` and `allInstances` to the template replacements object:

```javascript
let replacements = {
  // ... existing replacements ...
  api_url: API_URL,
  all_instances: JSON.stringify(allInstances || []),
  // ... rest of replacements
};
```

- [ ] **Step 2: Add deprecation warning to legacy webhook**

In `index.js`, find `POST /webhook/:project_id` (~line 926). Add at the start of the handler:

```javascript
winston.warn('(wab) Legacy webhook route used for project ' + req.params.project_id + '. Migrate to OAuth.');
```

- [ ] **Step 3: Commit**

```bash
git add pubmodules/whatsapp/connector/index.js
git commit -m "feat(multi-instance-wa): configure route passes all instances, legacy webhook deprecation warning"
```

---

### Task 9: Cleanup and kvstore Index

**Files:**
- Modify: `package.json` (verify npm dep removed)
- Modify: `Dockerfile` (verify sed removed)

- [ ] **Step 1: Verify package.json has no WhatsApp connector dependency**

```bash
grep "tiledesk-whatsapp-connector" package.json
```

Expected: No output (already removed in Task 1).

- [ ] **Step 2: Verify Dockerfile has no sed patch**

```bash
grep "tiledesk-whatsapp-connector" Dockerfile
```

Expected: No output (already removed in Task 1).

- [ ] **Step 3: Create kvstore index for phone_number_id lookups**

Add to the connector's initialization or run manually:

```bash
cd C:\Users\enzo\tiledesk
docker compose exec mongo mongosh tiledesk --eval "db.kvstore.createIndex({ 'value.phone_number_id': 1 })"
```

- [ ] **Step 4: Commit any remaining changes**

```bash
git add -A
git commit -m "feat(multi-instance-wa): cleanup and kvstore phone_number_id index"
```

---

### Task 10: E2E Verification

- [ ] **Step 1: Rebuild Docker**

```bash
cd C:\Users\enzo\tiledesk
docker compose up -d --build server
```

- [ ] **Step 2: Verify WhatsApp connector loads**

Check logs for:
```
Tiledesk Messenger Connector proxy server succesfully started.
```

- [ ] **Step 3: Verify Embedded Signup still works**

Navigate to dashboard > Integrations > WhatsApp. Click "Authorize WhatsApp". Verify the OAuth popup opens with correct scopes.

- [ ] **Step 4: Verify existing WhatsApp connection still works**

Send a message to the connected WhatsApp number. Verify it appears in the dashboard. Reply from dashboard. Verify it arrives on WhatsApp.

- [ ] **Step 5: Test duplicate detection**

Try to connect the same phone_number_id again. Should get 409.

- [ ] **Step 6: Verify GET /instances returns connected numbers**

```bash
curl -s "http://localhost:3000/{project_id}/integration/name/whatsapp/instances" -H "Authorization: {token}"
```

Expected: Array with the connected WhatsApp instance(s).

- [ ] **Step 7: Test multi-instance (if second number available)**

Connect a second WhatsApp number via Embedded Signup. Verify both appear in GET /instances. Send message to each. Verify outbound routes through correct number.
