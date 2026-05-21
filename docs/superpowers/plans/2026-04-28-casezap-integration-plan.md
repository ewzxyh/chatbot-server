# CaseZap (UazApi) Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a CaseZap (UazApi WhatsApp QR Code) channel to Tiledesk, enabling users to connect WhatsApp instances via 4 simple fields (number, domain, token, instanceName) with automatic webhook registration, inbound/outbound message handling, and full media type support.

**Architecture:** New inline pubmodule `pubmodules/casezap/` following the existing channel connector pattern. Express router mounted at `/modules/casezap` handles inbound webhooks from UazApi. Outbound messages are sent by listening to the internal `message.sending` event and calling UazApi's REST API. Auto-registers webhook on UazApi when integration is created.

**Tech Stack:** Node.js, Express, Mongoose, axios (HTTP client for UazApi API), lru-cache (deduplication), uuid (webhook secret generation)

**Spec:** `docs/superpowers/specs/2026-04-28-casezap-integration-design.md`

---

## File Structure

### Create
| File | Responsibility |
|---|---|
| `pubmodules/casezap/messageMapper.js` | Pure functions: UazApi ↔ Tiledesk message normalization |
| `pubmodules/casezap/connector.js` | Express router (inbound webhook), outbound sender, webhook registration/cleanup |
| `pubmodules/casezap/listener.js` | Listener class, wires connector to Tiledesk events |
| `pubmodules/casezap/index.js` | Module entry point, exports `{ listener, casezapRoute }` |
| `test/casezap/messageMapper.test.js` | Unit tests for messageMapper |
| Dashboard: `src/app/casezap/casezap.module.ts` | Angular lazy-loaded module |
| Dashboard: `src/app/casezap/casezap.component.ts` | CaseZap config component (4-field form + status) |
| Dashboard: `src/app/casezap/casezap.component.html` | Template |
| Dashboard: `src/app/casezap/casezap.component.scss` | Styles |

### Modify
| File | Change |
|---|---|
| `models/channelConstants.js` | Add `CASEZAP: 'casezap'` |
| `routes/integration.js` | Add `'casezap'` to `PLATFORM_CHANNELS`, `CHANNEL_FLAG_MAP`, duplicate domain+token check |
| `pubmodules/pubModulesManager.js` | Register casezap module in `init()` and `use()` |
| `package.json` | Add `axios`, `lru-cache`, `uuid` dependencies |
| Dashboard: `src/app/app.routing.ts` | Add CaseZap route |
| Dashboard: `src/app/components/sidebar/sidebar.component.html` | Add CaseZap sidebar item |
| Dashboard: `src/app/components/sidebar/sidebar.component.ts` | Add CaseZap visibility logic |

---

### Task 1: Foundation — Channel Constant, Quota Enforcement, Dependencies

**Files:**
- Modify: `models/channelConstants.js`
- Modify: `routes/integration.js:9` and `routes/integration.js:86`
- Modify: `package.json`

- [ ] **Step 1: Add CASEZAP to channel constants**

In `models/channelConstants.js`, add `CASEZAP` after the `EMAIL` entry:

```javascript
module.exports = {
        CHAT21 : 'chat21',
        FACEBOOK : 'facebook',
        TELEGRAM : 'telegram',
        WHATSAPP : 'whatsapp',
        FORM : 'form',   
        EMAIL : 'email',
        CASEZAP : 'casezap',
}
```

- [ ] **Step 2: Add casezap to PLATFORM_CHANNELS**

In `routes/integration.js`, line 9, add `'casezap'` to the array:

```javascript
const PLATFORM_CHANNELS = ['whatsapp', 'telegram', 'messenger', 'sms', 'voice', 'voice_twilio', 'casezap'];
```

- [ ] **Step 3: Add casezap to CHANNEL_FLAG_MAP**

In `routes/integration.js`, inside the `router.post('/')` handler (~line 86), add `'casezap'` to the map:

```javascript
var CHANNEL_FLAG_MAP = { 'whatsapp': 'whatsapp', 'telegram': 'telegram', 'messenger': 'messanger', 'casezap': 'casezap' };
```

- [ ] **Step 4: Add duplicate domain+token check for casezap**

In `routes/integration.js`, inside the `router.post('/')` handler, AFTER the existing `PLATFORM_CHANNELS` quota check block (after the closing `}` of the `if (PLATFORM_CHANNELS.includes(req.body.name))` block, around line 119), add:

```javascript
    if (req.body.name === 'casezap' && req.body.value && req.body.value.domain && req.body.value.token) {
        try {
            let duplicate = await Integration.findOne({
                name: 'casezap',
                id_project: { $ne: id_project },
                'value.domain': req.body.value.domain,
                'value.token': req.body.value.token
            });
            if (duplicate) {
                return res.status(409).json({
                    error: 'casezap_duplicate_instance',
                    message: 'This UazApi instance is already connected to another project'
                });
            }
        } catch (dupErr) {
            winston.error('Error checking CaseZap duplicate', dupErr);
        }
    }
```

- [ ] **Step 5: Install dependencies**

Run:
```bash
cd C:\Users\enzo\tiledesk-server
npm install axios lru-cache@6.0.0 uuid --save
```

Note: `lru-cache@6.0.0` is used for Node.js compatibility (v6 uses require, v7+ is ESM-only).

- [ ] **Step 6: Verify no errors**

Run:
```bash
cd C:\Users\enzo\tiledesk-server
node -e "require('./models/channelConstants')"
```

Expected: No errors, exits cleanly.

- [ ] **Step 7: Commit**

```bash
git add models/channelConstants.js routes/integration.js package.json package-lock.json
git commit -m "feat(casezap): add channel constant, quota enforcement, and dependencies"
```

---

### Task 2: Message Mapper — UazApi ↔ Tiledesk Normalization

**Files:**
- Create: `pubmodules/casezap/messageMapper.js`
- Create: `test/casezap/messageMapper.test.js`

- [ ] **Step 1: Create the messageMapper module**

Create `pubmodules/casezap/messageMapper.js`:

```javascript
var winston = require('../../config/winston');

function extractPhone(jid) {
  if (!jid) return null;
  return jid.replace('@s.whatsapp.net', '').replace('@lid', '');
}

function mapInbound(webhookData) {
  var msg = webhookData.data || webhookData;
  var key = msg.key || {};
  var remoteJid = key.remoteJid || '';
  var phone = extractPhone(remoteJid);
  var messageContent = msg.message || {};
  var messageType = msg.messageType || '';
  var pushName = msg.pushName || '';

  var result = {
    messageId: key.id,
    phone: phone,
    leadId: 'casezap-' + phone,
    fullname: pushName || phone,
    fromMe: key.fromMe || false,
    isGroup: remoteJid.includes('@g.us'),
    timestamp: msg.messageTimestamp || Date.now(),
    text: null,
    type: 'text',
    metadata: null
  };

  switch (messageType) {
    case 'conversation':
      result.text = messageContent.conversation || msg.body || '';
      result.type = 'text';
      break;

    case 'extendedTextMessage':
      result.text = (messageContent.extendedTextMessage && messageContent.extendedTextMessage.text) || '';
      result.type = 'text';
      break;

    case 'imageMessage':
      result.type = 'image';
      result.text = (messageContent.imageMessage && messageContent.imageMessage.caption) || '';
      result.metadata = {
        src: messageContent.imageMessage && messageContent.imageMessage.url,
        width: messageContent.imageMessage && messageContent.imageMessage.width,
        height: messageContent.imageMessage && messageContent.imageMessage.height,
        type: 'image'
      };
      break;

    case 'videoMessage':
      result.type = 'frame';
      result.text = (messageContent.videoMessage && messageContent.videoMessage.caption) || '';
      result.metadata = {
        src: messageContent.videoMessage && messageContent.videoMessage.url,
        type: 'video'
      };
      break;

    case 'audioMessage':
    case 'pttMessage':
      result.type = 'file';
      result.metadata = {
        src: (messageContent.audioMessage && messageContent.audioMessage.url) ||
             (messageContent.pttMessage && messageContent.pttMessage.url),
        type: 'audio'
      };
      break;

    case 'documentMessage':
      result.type = 'file';
      result.text = (messageContent.documentMessage && messageContent.documentMessage.title) || '';
      result.metadata = {
        src: messageContent.documentMessage && messageContent.documentMessage.url,
        name: (messageContent.documentMessage && messageContent.documentMessage.fileName) || 'document',
        type: 'file'
      };
      break;

    case 'stickerMessage':
      result.type = 'image';
      result.metadata = {
        src: messageContent.stickerMessage && messageContent.stickerMessage.url,
        type: 'image'
      };
      break;

    case 'locationMessage':
      var loc = messageContent.locationMessage || {};
      result.type = 'text';
      result.text = (loc.name ? loc.name + '\n' : '') +
        (loc.address ? loc.address + '\n' : '') +
        'https://maps.google.com/?q=' + (loc.degreesLatitude || 0) + ',' + (loc.degreesLongitude || 0);
      break;

    case 'contactMessage':
    case 'contactsArrayMessage':
      result.type = 'text';
      var contacts = messageContent.contactsArrayMessage
        ? messageContent.contactsArrayMessage.contacts
        : (messageContent.contactMessage ? [messageContent.contactMessage] : []);
      result.text = contacts.map(function(c) {
        return (c.displayName || 'Contact') + ': ' + (c.vcard || '');
      }).join('\n');
      break;

    case 'reactionMessage':
      return null;

    default:
      result.type = 'text';
      result.text = '[' + messageType + ']';
      break;
  }

  return result;
}

function mapOutbound(tiledeskMessage, recipientPhone) {
  var number = recipientPhone;
  var text = tiledeskMessage.text || '';
  var type = tiledeskMessage.type || 'text';
  var metadata = tiledeskMessage.metadata || {};
  var attributes = tiledeskMessage.attributes || {};

  if (attributes.attachment && attributes.attachment.type) {
    type = attributes.attachment.type;
    metadata = attributes.attachment;
  }

  if (type === 'text' && !metadata.src) {
    if (attributes.attachment && attributes.attachment.buttons && attributes.attachment.buttons.length > 0) {
      return {
        endpoint: '/send/menu',
        body: {
          number: number,
          type: 'button',
          text: text,
          choices: attributes.attachment.buttons.map(function(b) { return b.value || b.label || b.title; })
        }
      };
    }
    return {
      endpoint: '/send/text',
      body: { number: number, text: text }
    };
  }

  if (type === 'image' || (metadata.type === 'image')) {
    return {
      endpoint: '/send/media',
      body: {
        number: number,
        file: metadata.src || metadata.url,
        type: 'image',
        text: text || undefined
      }
    };
  }

  if (type === 'frame' || metadata.type === 'video') {
    return {
      endpoint: '/send/media',
      body: {
        number: number,
        file: metadata.src || metadata.url,
        type: 'video',
        text: text || undefined
      }
    };
  }

  if (type === 'file') {
    if (metadata.type === 'audio') {
      return {
        endpoint: '/send/media',
        body: {
          number: number,
          file: metadata.src || metadata.url,
          type: 'audio'
        }
      };
    }
    return {
      endpoint: '/send/media',
      body: {
        number: number,
        file: metadata.src || metadata.url,
        type: 'document',
        docName: metadata.name || 'document'
      }
    };
  }

  if (type === 'gallery' || (attributes.attachment && attributes.attachment.gallery)) {
    var gallery = attributes.attachment.gallery || [];
    return {
      endpoint: '/send/carousel',
      body: {
        number: number,
        text: text,
        choices: gallery.map(function(card) {
          var btns = (card.buttons || []).map(function(b) { return '[' + (b.value || b.label) + ']'; }).join('');
          return '[' + (card.title || '') + ']{' + (card.image || '') + '}' + btns;
        })
      }
    };
  }

  return {
    endpoint: '/send/text',
    body: { number: number, text: text || '[unsupported message type]' }
  };
}

module.exports = {
  mapInbound: mapInbound,
  mapOutbound: mapOutbound,
  extractPhone: extractPhone
};
```

- [ ] **Step 2: Write unit tests**

Create `test/casezap/messageMapper.test.js`:

```javascript
var assert = require('assert');
var messageMapper = require('../../pubmodules/casezap/messageMapper');

describe('CaseZap messageMapper', function() {

  describe('extractPhone', function() {
    it('should extract phone from s.whatsapp.net JID', function() {
      assert.strictEqual(messageMapper.extractPhone('redacted@example.invalid'), '5511999999999');
    });

    it('should extract phone from lid JID', function() {
      assert.strictEqual(messageMapper.extractPhone('5511999999999@lid'), '5511999999999');
    });

    it('should return null for null input', function() {
      assert.strictEqual(messageMapper.extractPhone(null), null);
    });
  });

  describe('mapInbound', function() {
    it('should map conversation text message', function() {
      var webhook = {
        data: {
          key: { id: 'msg-001', remoteJid: 'redacted@example.invalid', fromMe: false },
          message: { conversation: 'Ola!' },
          messageType: 'conversation',
          pushName: 'Maria'
        }
      };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.text, 'Ola!');
      assert.strictEqual(result.type, 'text');
      assert.strictEqual(result.phone, '5511999999999');
      assert.strictEqual(result.leadId, 'casezap-5511999999999');
      assert.strictEqual(result.fullname, 'Maria');
      assert.strictEqual(result.messageId, 'msg-001');
      assert.strictEqual(result.fromMe, false);
      assert.strictEqual(result.isGroup, false);
    });

    it('should map image message with caption', function() {
      var webhook = {
        data: {
          key: { id: 'msg-002', remoteJid: 'redacted@example.invalid', fromMe: false },
          message: { imageMessage: { url: 'https://cdn.example.com/img.jpg', caption: 'Look at this', width: 800, height: 600 } },
          messageType: 'imageMessage',
          pushName: 'Maria'
        }
      };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.type, 'image');
      assert.strictEqual(result.text, 'Look at this');
      assert.strictEqual(result.metadata.src, 'https://cdn.example.com/img.jpg');
    });

    it('should map audio message', function() {
      var webhook = {
        data: {
          key: { id: 'msg-003', remoteJid: 'redacted@example.invalid', fromMe: false },
          message: { audioMessage: { url: 'https://cdn.example.com/audio.ogg' } },
          messageType: 'audioMessage',
          pushName: 'Maria'
        }
      };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.type, 'file');
      assert.strictEqual(result.metadata.type, 'audio');
    });

    it('should map location message with Google Maps link', function() {
      var webhook = {
        data: {
          key: { id: 'msg-004', remoteJid: 'redacted@example.invalid', fromMe: false },
          message: { locationMessage: { degreesLatitude: -23.55, degreesLongitude: -46.63, name: 'Sao Paulo' } },
          messageType: 'locationMessage',
          pushName: 'Maria'
        }
      };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.type, 'text');
      assert.ok(result.text.includes('maps.google.com'));
      assert.ok(result.text.includes('-23.55'));
    });

    it('should return null for reaction messages', function() {
      var webhook = {
        data: {
          key: { id: 'msg-005', remoteJid: 'redacted@example.invalid', fromMe: false },
          message: { reactionMessage: { text: '👍' } },
          messageType: 'reactionMessage',
          pushName: 'Maria'
        }
      };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result, null);
    });

    it('should detect group JIDs', function() {
      var webhook = {
        data: {
          key: { id: 'msg-006', remoteJid: 'redacted@example.invalid', fromMe: false },
          message: { conversation: 'group msg' },
          messageType: 'conversation',
          pushName: 'Maria'
        }
      };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.isGroup, true);
    });
  });

  describe('mapOutbound', function() {
    it('should map text message to /send/text', function() {
      var msg = { text: 'Hello!', type: 'text' };
      var result = messageMapper.mapOutbound(msg, '5511999999999');
      assert.strictEqual(result.endpoint, '/send/text');
      assert.strictEqual(result.body.number, '5511999999999');
      assert.strictEqual(result.body.text, 'Hello!');
    });

    it('should map image to /send/media', function() {
      var msg = { text: 'caption', type: 'image', metadata: { src: 'https://img.com/x.jpg', type: 'image' } };
      var result = messageMapper.mapOutbound(msg, '5511999999999');
      assert.strictEqual(result.endpoint, '/send/media');
      assert.strictEqual(result.body.type, 'image');
      assert.strictEqual(result.body.file, 'https://img.com/x.jpg');
      assert.strictEqual(result.body.text, 'caption');
    });

    it('should map document to /send/media with docName', function() {
      var msg = { type: 'file', metadata: { src: 'https://x.com/f.pdf', name: 'report.pdf', type: 'file' } };
      var result = messageMapper.mapOutbound(msg, '5511999999999');
      assert.strictEqual(result.endpoint, '/send/media');
      assert.strictEqual(result.body.type, 'document');
      assert.strictEqual(result.body.docName, 'report.pdf');
    });

    it('should map buttons to /send/menu', function() {
      var msg = { text: 'Choose:', type: 'text', attributes: { attachment: { buttons: [{ label: 'Yes' }, { label: 'No' }] } } };
      var result = messageMapper.mapOutbound(msg, '5511999999999');
      assert.strictEqual(result.endpoint, '/send/menu');
      assert.strictEqual(result.body.type, 'button');
      assert.deepStrictEqual(result.body.choices, ['Yes', 'No']);
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run:
```bash
cd C:\Users\enzo\tiledesk-server
npx mocha test/casezap/messageMapper.test.js --exit
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add pubmodules/casezap/messageMapper.js test/casezap/messageMapper.test.js
git commit -m "feat(casezap): add message mapper with inbound/outbound normalization"
```

---

### Task 3: Connector — Inbound Webhook Handler

**Files:**
- Create: `pubmodules/casezap/connector.js`

**Reference files to check:**
- `channels/chat21/chat21WebHook.js` — how chat21 creates leads, requests, messages
- `services/leadService.js` — `createIfNotExistsWithLeadId()` signature
- `services/requestService.js` — `create()` signature
- `services/messageService.js` — `send()` signature
- `models/request.js` — request schema, channel fields

- [ ] **Step 1: Create connector.js with inbound webhook handler**

Create `pubmodules/casezap/connector.js`:

```javascript
var express = require('express');
var router = express.Router();
var winston = require('../../config/winston');
var axios = require('axios');
var LRU = require('lru-cache');
var { v4: uuidv4 } = require('uuid');
var messageMapper = require('./messageMapper');
var Integration = require('../../models/integrations');
var ChannelConstants = require('../../models/channelConstants');
var MessageConstants = require('../../models/messageConstants');
var Request = require('../../models/request');
var leadService = require('../../services/leadService');
var requestService = require('../../services/requestService');
var messageService = require('../../services/messageService');
var messageEvent = require('../../event/messageEvent');
var integrationEvent = require('../../event/integrationEvent');

var processedMessages = new LRU({ max: 10000, maxAge: 1000 * 60 * 60 });
var casezapProjects = new Map();
var casezapEnabled = process.env.CASEZAP_ENABLED !== 'false';

router.post('/webhook/:project_id', async function(req, res) {
  if (!casezapEnabled) {
    return res.status(503).json({ error: 'CaseZap module disabled' });
  }
  var projectId = req.params.project_id;
  var secret = REDACTED_SECRET;

  try {
    var integration = await Integration.findOne({ id_project: projectId, name: 'casezap' });
    if (!integration || !integration.value || integration.value.webhookSecret !== secret) {
      winston.warn('CaseZap webhook: invalid secret for project ' + projectId);
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }

    var body = req.body;
    if (!body || !body.EventType) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    if (body.EventType === 'connection') {
      var newStatus = (body.data && body.data.state === 'open') ? 'active' : 'disconnected';
      await Integration.findOneAndUpdate(
        { id_project: projectId, name: 'casezap' },
        { $set: { 'value.status': newStatus } }
      );
      winston.info('CaseZap connection event: project ' + projectId + ' status=' + newStatus);
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

    var lead = await leadService.createIfNotExistsWithLeadId(
      mapped.leadId,
      mapped.fullname,
      null,
      projectId,
      mapped.leadId,
      null,
      null,
      mapped.phone
    );

    var existingRequest = await Request.findOne({
      id_project: projectId,
      'channel.name': ChannelConstants.CASEZAP,
      lead: lead._id,
      status: { $lt: 1000 }
    }).sort({ createdAt: -1 });

    var requestId;
    if (existingRequest) {
      requestId = existingRequest.request_id;
    } else {
      requestId = 'support-group-' + projectId + '-' + uuidv4();
      var newRequest = {
        request_id: requestId,
        id_project: projectId,
        lead_id: lead._id,
        lead: lead,
        first_text: mapped.text || '',
        channel: { name: ChannelConstants.CASEZAP },
        createdBy: mapped.leadId,
        attributes: { casezapPhone: mapped.phone }
      };
      await requestService.create(newRequest);
    }

    var senderFullname = mapped.fullname || mapped.phone;
    messageService.send(
      mapped.leadId,
      senderFullname,
      requestId,
      mapped.text,
      projectId,
      mapped.leadId,
      { casezapMessageId: mapped.messageId },
      mapped.type,
      mapped.metadata,
      null
    );

    res.status(200).json({ success: true });

  } catch (err) {
    winston.error('CaseZap webhook error for project ' + projectId, err);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = {
  router: router,
  processedMessages: processedMessages,
  casezapProjects: casezapProjects
};
```

- [ ] **Step 2: Verify the file loads without syntax errors**

Run:
```bash
cd C:\Users\enzo\tiledesk-server
node -e "require('./pubmodules/casezap/connector')"
```

Expected: No syntax errors (may fail on missing DB connection, that's OK — we just check syntax).

- [ ] **Step 3: Commit**

```bash
git add pubmodules/casezap/connector.js
git commit -m "feat(casezap): add inbound webhook handler with lead/request/message creation"
```

---

### Task 4: Connector — Outbound Sender + Connection Events

**Files:**
- Modify: `pubmodules/casezap/connector.js`

**Reference:** `channels/chat21/chat21Handler.js:264-310` — how `message.sending` is handled.

- [ ] **Step 1: Add outbound sender function to connector.js**

Add the following functions to `pubmodules/casezap/connector.js`, BEFORE the `module.exports`:

```javascript
async function sendToUazApi(domain, token, endpoint, body) {
  var url = domain.replace(/\/$/, '') + endpoint;
  try {
    var response = await axios.post(url, body, {
      headers: { 'token': token, 'Content-Type': 'application/json' },
      timeout: 10000
    });
    return response.data;
  } catch (err) {
    if (err.response && err.response.status === 429) {
      winston.warn('CaseZap rate limited on ' + endpoint);
      return null;
    }
    throw err;
  }
}

async function sendOutboundMessage(message) {
  try {
    if (!message || !message.request || !message.request.channel) return;
    if (message.status !== MessageConstants.CHAT_MESSAGE_STATUS.SENDING) return;
    if (message.channel_type !== MessageConstants.CHANNEL_TYPE.GROUP) return;
    if (message.request.channel.name !== ChannelConstants.CASEZAP) return;

    var leadId = message.request.lead && message.request.lead.lead_id;
    if (message.sender === leadId) return;

    var projectId = message.id_project;
    var integration = await Integration.findOne({ id_project: projectId, name: 'casezap' });
    if (!integration || !integration.value) {
      winston.warn('CaseZap integration not found for project ' + projectId);
      return;
    }

    if (integration.value.status === 'disconnected') {
      winston.warn('CaseZap instance disconnected for project ' + projectId);
      return;
    }

    var phone = leadId.replace('casezap-', '');
    var outbound = messageMapper.mapOutbound(message, phone);

    try {
      await sendToUazApi(integration.value.domain, integration.value.token, outbound.endpoint, outbound.body);
      winston.debug('CaseZap sent message to ' + phone + ' via ' + outbound.endpoint);
    } catch (firstErr) {
      winston.warn('CaseZap send failed, retrying in 2s: ' + firstErr.message);
      await new Promise(function(resolve) { setTimeout(resolve, 2000); });
      try {
        await sendToUazApi(integration.value.domain, integration.value.token, outbound.endpoint, outbound.body);
        winston.debug('CaseZap retry succeeded for ' + phone);
      } catch (retryErr) {
        winston.error('CaseZap send failed after retry to ' + phone, retryErr);
      }
    }

  } catch (err) {
    winston.error('CaseZap outbound error', err);
  }
}

function setupOutboundListener() {
  messageEvent.on('message.sending', function(message) {
    sendOutboundMessage(message);
  });
  winston.info('CaseZap outbound listener registered');
}
```

- [ ] **Step 2: Add webhook registration and cleanup functions**

Add these functions BEFORE `module.exports` in connector.js:

```javascript
async function registerWebhook(integration, projectId, baseUrl) {
  var domain = integration.value.domain;
  var token = integration.value.token;
  var webhookSecret = REDACTED_SECRET || uuidv4();
  var webhookUrl = baseUrl + '/modules/casezap/webhook/' + projectId + '?secret=' + webhookSecret;

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

    await Integration.findOneAndUpdate(
      { id_project: projectId, name: 'casezap' },
      { $set: { 'value.webhookSecret': webhookSecret, 'value.status': 'active' } }
    );

    casezapProjects.set(projectId, { domain: domain, token: token });
    winston.info('CaseZap webhook registered for project ' + projectId);
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

async function cleanupWebhook(projectId, domain, token, baseUrl) {
  var webhookUrl = baseUrl + '/modules/casezap/webhook/' + projectId;
  try {
    await axios.post(domain.replace(/\/$/, '') + '/webhook', {
      action: 'delete',
      url: webhookUrl
    }, {
      headers: { 'token': token, 'Content-Type': 'application/json' },
      timeout: 10000
    });
    winston.info('CaseZap webhook cleaned up for project ' + projectId);
  } catch (err) {
    winston.warn('CaseZap webhook cleanup failed for project ' + projectId + ': ' + err.message);
  }
}

function setupIntegrationListener(baseUrl) {
  integrationEvent.on('integration.update', function(integrations, projectId) {
    var hasCasezap = integrations.some(function(i) { return i.name === 'casezap'; });
    var hadCasezap = casezapProjects.has(projectId);

    if (hasCasezap) {
      var czIntegration = integrations.find(function(i) { return i.name === 'casezap'; });
      if (czIntegration && czIntegration.value) {
        casezapProjects.set(projectId, {
          domain: czIntegration.value.domain,
          token: czIntegration.value.token
        });
      }
    } else if (hadCasezap) {
      var prev = casezapProjects.get(projectId);
      casezapProjects.delete(projectId);
      if (prev && prev.domain && prev.token) {
        cleanupWebhook(projectId, prev.domain, prev.token, baseUrl);
      }
    }
  });
  winston.info('CaseZap integration listener registered');
}
```

- [ ] **Step 3: Add webhook registration route**

Add this route to connector.js, AFTER the existing `/webhook/:project_id` route and BEFORE `module.exports`:

```javascript
router.post('/register/:project_id', async function(req, res) {
  var projectId = req.params.project_id;
  var baseUrl = req.body.baseUrl || process.env.API_URL || '';

  try {
    var integration = await Integration.findOne({ id_project: projectId, name: 'casezap' });
    if (!integration || !integration.value) {
      return res.status(404).json({ error: 'CaseZap integration not found' });
    }

    var result = await registerWebhook(integration, projectId, baseUrl);
    res.status(200).json(result);
  } catch (err) {
    winston.error('CaseZap register webhook error', err);
    res.status(502).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Update module.exports**

Replace the `module.exports` at the bottom of connector.js:

```javascript
module.exports = {
  router: router,
  setupOutboundListener: setupOutboundListener,
  setupIntegrationListener: setupIntegrationListener,
  registerWebhook: registerWebhook,
  processedMessages: processedMessages,
  casezapProjects: casezapProjects
};
```

- [ ] **Step 5: Verify no syntax errors**

Run:
```bash
cd C:\Users\enzo\tiledesk-server
node -e "require('./pubmodules/casezap/connector')"
```

Expected: No syntax errors.

- [ ] **Step 6: Commit**

```bash
git add pubmodules/casezap/connector.js
git commit -m "feat(casezap): add outbound sender, webhook registration, and cleanup"
```

---

### Task 5: Listener + Index + Module Registration

**Files:**
- Create: `pubmodules/casezap/listener.js`
- Create: `pubmodules/casezap/index.js`
- Modify: `pubmodules/pubModulesManager.js`

**Reference:** `pubmodules/whatsapp/listener.js` and `pubmodules/whatsapp/index.js` for exact pattern.

- [ ] **Step 1: Create listener.js**

Create `pubmodules/casezap/listener.js`:

```javascript
var winston = require('../../config/winston');
var configGlobal = require('../../config/global');
var connector = require('./connector');

var apiUrl = process.env.API_URL || configGlobal.apiUrl;
var casezapEnabled = process.env.CASEZAP_ENABLED !== 'false';

class Listener {

  listen(config) {
    if (!casezapEnabled) {
      winston.info('CaseZap module disabled via CASEZAP_ENABLED=false');
      return;
    }

    winston.info('CaseZap Listener initializing');

    var baseUrl = apiUrl;

    connector.setupOutboundListener();
    connector.setupIntegrationListener(baseUrl);

    winston.info('CaseZap Listener initialized. Base URL: ' + baseUrl);
  }
}

var listener = new Listener();

module.exports = listener;
```

- [ ] **Step 2: Create index.js**

Create `pubmodules/casezap/index.js`:

```javascript
var listener = require('./listener');
var connector = require('./connector');
var casezapRoute = connector.router;

module.exports = { listener: listener, casezapRoute: casezapRoute };
```

- [ ] **Step 3: Register casezap in pubModulesManager.js init()**

In `pubmodules/pubModulesManager.js`, first add `this.casezap = undefined;` and `this.casezapRoute = undefined;` in the constructor (alongside the other module declarations around lines 28-76). Then, inside the `init(config)` method, AFTER the telegram block (~line 354), add:

```javascript
        try {
            this.casezap = require('./casezap');
            winston.info("this.casezap: " + this.casezap);
            this.casezap.listener.listen(config);

            this.casezapRoute = this.casezap.casezapRoute;

            winston.info("PubModulesManager initialized apps (casezap).");
        } catch(err) {
            if (err.code == 'MODULE_NOT_FOUND') {
                winston.info("PubModulesManager init casezap module not found");
            } else {
                winston.info("PubModulesManager error initializing init casezap module", err);
            }
        }
```

- [ ] **Step 4: Mount casezap route in pubModulesManager.js use()**

In `pubmodules/pubModulesManager.js`, inside the `use(app)` method, AFTER the telegram route mount (~line 101), add:

```javascript
        if (this.casezapRoute) {
            app.use('/modules/casezap', this.casezapRoute);
            winston.info("PubModulesManager casezapRoute controller loaded");
        }
```

- [ ] **Step 5: Verify module loads**

Run:
```bash
cd C:\Users\enzo\tiledesk-server
node -e "require('./pubmodules/casezap')"
```

Expected: No errors (may show config warnings, that's OK).

- [ ] **Step 6: Commit**

```bash
git add pubmodules/casezap/listener.js pubmodules/casezap/index.js pubmodules/pubModulesManager.js
git commit -m "feat(casezap): add listener, index, and register module in pubModulesManager"
```

---

### Task 6: Dashboard — CaseZap Configuration Component

**Files (all in `C:\Users\enzo\tiledesk-dashboard`):**
- Create: `src/app/casezap/casezap.module.ts`
- Create: `src/app/casezap/casezap.component.ts`
- Create: `src/app/casezap/casezap.component.html`
- Create: `src/app/casezap/casezap.component.scss`
- Modify: `src/app/app.routing.ts`
- Modify: `src/app/components/sidebar/sidebar.component.html`
- Modify: `src/app/components/sidebar/sidebar.component.ts`

**Reference:** `src/app/casepay-pricing/` for standalone lazy-loaded module pattern.

- [ ] **Step 1: Create the CaseZap module**

Create `src/app/casezap/casezap.module.ts`:

```typescript
import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule, Routes } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { CasezapComponent } from './casezap.component';

const routes: Routes = [
  { path: '', component: CasezapComponent }
];

@NgModule({
  declarations: [CasezapComponent],
  imports: [
    CommonModule,
    FormsModule,
    TranslateModule,
    RouterModule.forChild(routes)
  ]
})
export class CasezapModule { }
```

- [ ] **Step 2: Create the CaseZap component TypeScript**

Create `src/app/casezap/casezap.component.ts`:

```typescript
import { Component, OnInit, OnDestroy } from '@angular/core';
import { Subscription } from 'rxjs';
import { IntegrationService } from '../services/integration.service';
import { AuthService } from '../core/auth.service';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { AppConfigService } from '../services/app-config.service';

@Component({
  selector: 'app-casezap',
  templateUrl: './casezap.component.html',
  styleUrls: ['./casezap.component.scss']
})
export class CasezapComponent implements OnInit, OnDestroy {
  number = '';
  domain = '';
  token = '';
  instanceName = '';
  status = '';
  loading = true;
  saving = false;
  error = '';
  success = '';
  existingIntegration: any = null;
  projectId: string;
  serverBaseUrl: string;
  TOKEN: string;
  private subs: Subscription[] = [];

  constructor(
    private integrationService: IntegrationService,
    private auth: AuthService,
    private http: HttpClient,
    private appConfig: AppConfigService
  ) {
    this.serverBaseUrl = this.appConfig.getConfig().SERVER_BASE_URL;
  }

  ngOnInit() {
    this.subs.push(this.auth.project_bs.subscribe((project) => {
      if (project) {
        this.projectId = project._id;
        this.loadExisting();
      }
    }));
    const user = this.auth.user_bs.value;
    if (user) {
      this.TOKEN = user.token;
    }
  }

  ngOnDestroy() {
    this.subs.forEach(s => s.unsubscribe());
  }

  loadExisting() {
    this.loading = true;
    this.integrationService.getIntegrationByName('casezap').subscribe(
      (integration: any) => {
        this.loading = false;
        if (integration && integration.value) {
          this.existingIntegration = integration;
          this.number = integration.value.number || '';
          this.domain = integration.value.domain || '';
          this.token = integration.value.token || '';
          this.instanceName = integration.value.instanceName || '';
          this.status = integration.value.status || 'unknown';
        }
      },
      () => {
        this.loading = false;
      }
    );
  }

  save() {
    if (!this.number || !this.domain || !this.token || !this.instanceName) {
      this.error = 'Todos os campos são obrigatórios';
      return;
    }

    this.saving = true;
    this.error = '';
    this.success = '';

    const data = {
      name: 'casezap',
      value: {
        number: this.number,
        domain: this.domain,
        token: this.token,
        instanceName: this.instanceName
      }
    };

    this.integrationService.saveIntegration(data).subscribe(
      (result: any) => {
        this.existingIntegration = result;
        this.registerWebhook();
      },
      (err: any) => {
        this.saving = false;
        if (err.status === 409) {
          this.error = 'Esta instância já está conectada em outro projeto';
        } else if (err.status === 403) {
          this.error = 'Limite de plataformas atingido no seu plano';
        } else {
          this.error = 'Erro ao salvar integração';
        }
      }
    );
  }

  registerWebhook() {
    const url = this.serverBaseUrl + 'modules/casezap/register/' + this.projectId;
    const headers = new HttpHeaders({
      'Content-Type': 'application/json',
      Authorization: this.TOKEN
    });
    const body = { baseUrl: this.serverBaseUrl.replace(/\/$/, '') };

    this.http.post(url, body, { headers }).subscribe(
      () => {
        this.saving = false;
        this.success = 'CaseZap conectado com sucesso!';
        this.status = 'active';
      },
      (err: any) => {
        this.saving = false;
        this.error = err.error?.error || 'Erro ao registrar webhook';
      }
    );
  }

  remove() {
    if (!this.existingIntegration) return;
    if (!confirm('Deseja remover a integração CaseZap?')) return;

    this.saving = true;
    this.integrationService.deleteIntegration(this.existingIntegration._id).subscribe(
      () => {
        this.saving = false;
        this.existingIntegration = null;
        this.number = '';
        this.domain = '';
        this.token = '';
        this.instanceName = '';
        this.status = '';
        this.success = 'Integração removida';
      },
      () => {
        this.saving = false;
        this.error = 'Erro ao remover integração';
      }
    );
  }
}
```

- [ ] **Step 3: Create the CaseZap component template**

Create `src/app/casezap/casezap.component.html`:

```html
<div class="casezap-container">
  <div class="casezap-header">
    <div class="casezap-title">
      <img src="https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg" alt="WhatsApp" class="casezap-icon">
      <h2>CaseZap</h2>
      <span class="casezap-subtitle">WhatsApp via QR Code (UazApi)</span>
    </div>
    <div *ngIf="status" class="casezap-status" [class.active]="status === 'active'" [class.disconnected]="status === 'disconnected'">
      {{ status === 'active' ? 'Conectado' : 'Desconectado' }}
    </div>
  </div>

  <div *ngIf="loading" class="casezap-loading">
    Carregando...
  </div>

  <div *ngIf="!loading" class="casezap-form">
    <div *ngIf="error" class="casezap-alert error">{{ error }}</div>
    <div *ngIf="success" class="casezap-alert success">{{ success }}</div>

    <div class="casezap-field">
      <label>Número do WhatsApp *</label>
      <input type="text" [(ngModel)]="number" placeholder="e.g. 5511999999999" [disabled]="saving">
      <span class="casezap-hint">Número com código do país, sem + ou espaços</span>
    </div>

    <div class="casezap-field">
      <label>Domínio da API *</label>
      <input type="text" [(ngModel)]="domain" placeholder="e.g. https://chatcase.uazapi.com" [disabled]="saving">
      <span class="casezap-hint">URL da sua instância UazApi</span>
    </div>

    <div class="casezap-field">
      <label>Token de instância *</label>
      <input type="text" [(ngModel)]="token" placeholder="Token da instância UazApi" [disabled]="saving">
    </div>

    <div class="casezap-field">
      <label>Nome da instância *</label>
      <input type="text" [(ngModel)]="instanceName" placeholder="Nome da sua instância" [disabled]="saving">
    </div>

    <div class="casezap-actions">
      <button class="btn-primary" (click)="save()" [disabled]="saving">
        {{ saving ? 'Salvando...' : (existingIntegration ? 'Atualizar' : 'Conectar') }}
      </button>
      <button *ngIf="existingIntegration" class="btn-danger" (click)="remove()" [disabled]="saving">
        Remover
      </button>
    </div>

    <div *ngIf="!existingIntegration" class="casezap-instructions">
      <h3>Como conectar</h3>
      <ol>
        <li>Acesse o CaseZap e crie/conecte uma instância WhatsApp</li>
        <li>Copie as 4 informações da instância conectada</li>
        <li>Cole nos campos acima e clique em Conectar</li>
      </ol>
    </div>
  </div>
</div>
```

- [ ] **Step 4: Create the CaseZap component styles**

Create `src/app/casezap/casezap.component.scss`:

```scss
.casezap-container {
  max-width: 600px;
  margin: 24px auto;
  padding: 24px;
}

.casezap-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}

.casezap-title {
  display: flex;
  align-items: center;
  gap: 12px;

  h2 { margin: 0; font-size: 24px; }
}

.casezap-icon {
  width: 32px;
  height: 32px;
}

.casezap-subtitle {
  font-size: 13px;
  color: #888;
}

.casezap-status {
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 13px;
  font-weight: 500;

  &.active {
    background: #e8f5e9;
    color: #2e7d32;
  }

  &.disconnected {
    background: #fbe9e7;
    color: #c62828;
  }
}

.casezap-loading {
  text-align: center;
  padding: 48px;
  color: #888;
}

.casezap-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.casezap-field {
  display: flex;
  flex-direction: column;
  gap: 4px;

  label {
    font-size: 14px;
    font-weight: 500;
    color: #333;
  }

  input {
    padding: 10px 12px;
    border: 1px solid #ddd;
    border-radius: 6px;
    font-size: 14px;

    &:focus {
      outline: none;
      border-color: #25d366;
    }

    &:disabled {
      background: #f5f5f5;
    }
  }
}

.casezap-hint {
  font-size: 12px;
  color: #999;
}

.casezap-alert {
  padding: 10px 16px;
  border-radius: 6px;
  font-size: 14px;

  &.error {
    background: #fbe9e7;
    color: #c62828;
  }

  &.success {
    background: #e8f5e9;
    color: #2e7d32;
  }
}

.casezap-actions {
  display: flex;
  gap: 12px;
  margin-top: 8px;

  .btn-primary {
    padding: 10px 24px;
    background: #25d366;
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 14px;
    cursor: pointer;

    &:hover { background: #1da851; }
    &:disabled { opacity: 0.6; cursor: not-allowed; }
  }

  .btn-danger {
    padding: 10px 24px;
    background: white;
    color: #c62828;
    border: 1px solid #c62828;
    border-radius: 6px;
    font-size: 14px;
    cursor: pointer;

    &:hover { background: #fbe9e7; }
    &:disabled { opacity: 0.6; cursor: not-allowed; }
  }
}

.casezap-instructions {
  margin-top: 16px;
  padding: 16px;
  background: #f5f5f5;
  border-radius: 8px;

  h3 {
    margin: 0 0 12px;
    font-size: 15px;
  }

  ol {
    margin: 0;
    padding-left: 20px;

    li {
      font-size: 14px;
      color: #555;
      margin-bottom: 8px;
    }
  }
}
```

- [ ] **Step 5: Add CaseZap route to app.routing.ts**

In `C:\Users\enzo\tiledesk-dashboard\src\app\app.routing.ts`, add the route alongside other lazy-loaded modules (e.g., near the casepay-pricing route):

```typescript
  {
    path: 'project/:projectid/casezap',
    loadChildren: () => import('app/casezap/casezap.module').then(m => m.CasezapModule),
    canActivate: [AuthGuard]
  },
```

- [ ] **Step 6: Add CaseZap to sidebar**

In `C:\Users\enzo\tiledesk-dashboard\src\app\components\sidebar\sidebar.component.html`, AFTER the Integrations sidebar item (the `<a>` with `routerLink` to `integrations`), add:

```html
    <!-- CaseZap -->
    <div id="casezap-anchor-wpr" *ngIf="project"
      matTooltipClass="sb-mat-tooltip"
      matTooltip="CaseZap"
      #tooltip="matTooltip"
      matTooltipPosition='right'
      matTooltipHideDelay="100"
      routerLinkActive="item-active">
      <a id="casezap-anchor" class="customAncor" routerLink="project/{{ project._id }}/casezap">
        <span class="bot-icon-wpr">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="#25d366">
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
          </svg>
        </span>
      </a>
    </div>
```

Insert this block AFTER the WA Broadcasts sidebar block (after its closing `</ng-container>` tag), following the existing sidebar icon pattern with inline SVG inside `<span class="bot-icon-wpr">`.

- [ ] **Step 7: Build dashboard to verify no compilation errors**

Run:
```bash
cd C:\Users\enzo\tiledesk-dashboard
ng build --configuration=production 2>&1 | head -20
```

Expected: Build succeeds or shows only warnings (no errors).

- [ ] **Step 8: Commit**

```bash
cd C:\Users\enzo\tiledesk-dashboard
git add src/app/casezap/ src/app/app.routing.ts src/app/components/sidebar/sidebar.component.html
git commit -m "feat(casezap): add CaseZap configuration page and sidebar item"
```

---

### Task 7: Integration Test — End-to-End Verification

**Files:** No new files. This task verifies the full integration works.

- [ ] **Step 1: Run messageMapper unit tests**

```bash
cd C:\Users\enzo\tiledesk-server
npx mocha test/casezap/messageMapper.test.js --exit
```

Expected: All tests pass.

- [ ] **Step 2: Start the server and verify module loads**

```bash
cd C:\Users\enzo\tiledesk-server
npm start
```

Check logs for:
```
CaseZap Listener initializing
CaseZap outbound listener registered
CaseZap integration listener registered
CaseZap Listener initialized.
PubModulesManager initialized apps (casezap).
PubModulesManager casezapRoute controller loaded
```

- [ ] **Step 3: Test webhook endpoint responds**

```bash
curl -X POST "http://localhost:3000/modules/casezap/webhook/test-project?secret=wrong" \
  -H "Content-Type: application/json" \
  -d '{"EventType": "messages"}'
```

Expected: HTTP 401 `{"error":"Invalid webhook secret"}`

- [ ] **Step 4: Test integration duplicate check**

Create a casezap integration for project A, then try creating with same domain+token for project B.

Expected: Second creation returns HTTP 409 `{"error":"casezap_duplicate_instance"}`

- [ ] **Step 5: Test dashboard CaseZap page**

Navigate to `http://localhost:4500/#/project/{projectId}/casezap`

Expected: Form with 4 fields loads. Sidebar shows CaseZap icon.

- [ ] **Step 6: Rebuild Docker containers**

```bash
cd C:\Users\enzo\tiledesk
docker compose up -d --build tiledesk-server tiledesk-dashboard
```

- [ ] **Step 7: Test full flow with real UazApi instance (if available)**

1. Enter real CaseZap credentials in the form
2. Click "Conectar"
3. Send a WhatsApp message to the connected number
4. Verify message appears in the ChatCase agent panel
5. Reply from the agent panel
6. Verify reply arrives on WhatsApp

- [ ] **Step 8: Commit any fixes from testing**

```bash
git add -A
git commit -m "fix(casezap): fixes from integration testing"
```
