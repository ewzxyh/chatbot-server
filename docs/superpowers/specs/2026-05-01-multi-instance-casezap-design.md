# Multi-Instance CaseZap — Design Spec

## Objetivo

Permitir que um projeto tenha multiplas instancias CaseZap (UazApi WhatsApp). Cada instancia consome 1 slot da quota de plataformas. Ex: plano com 5 plataformas permite 5 CaseZap, ou 3 CaseZap + 1 Telegram + 1 WhatsApp.

Escopo: apenas CaseZap (conector inline). WhatsApp oficial, Telegram, Messenger (pacotes npm externos) ficam para fase futura.

## Decisoes de Design

- Apenas PLATFORM_CHANNELS suportam multi-instance (nao AI/CRM)
- Cada instancia identificada pelo `_id` do MongoDB (sem campo instance_id separado — _id ja e unico)
- Lead ID incorpora integration ID: `casezap-<integrationId>-<phone>`
- Request armazena `integrationId` + `attributes.instanceLabel`
- Webhook URL usa `integration_id` (nao `project_id`)
- Rota nova `/webhook/:integration_id`, rota legacy renomeada para `/webhook/project/:project_id` (fallback)
- Quota: cada instancia = 1 slot (3 CaseZap = 3 da quota)
- Conversas exibem icone WhatsApp + tooltip "CaseZap - Nome (numero)"

## Integration Model

### Schema

```javascript
{
  id_project: String,
  name: String,
  value: Object
}
```

Sem mudanca no schema. O `_id` do MongoDB ja identifica cada instancia univocamente. Sem campo `instance_id` adicional — seria redundante.

Index existente em `id_project` e suficiente. Multiplas instancias do mesmo canal sao documentos separados com `_id` diferentes.

### POST `/integration` — logica bifurcada

**PLATFORM_CHANNELS:**
- `create()` (nunca upsert) — cada POST cria novo documento
- REMOVER o guard `findOne({id_project, name})` que skipa quota se ja existe (linhas 116-117 atuais) — esse guard era para upsert, com multi-instance toda criacao conta
- Quota: `countDocuments({ id_project, name: { $in: PLATFORM_CHANNELS } })` — conta TODAS instancias de todos canais
- Duplicate check intra-projeto:
  ```javascript
  let intraDup = await Integration.findOne({
    id_project: id_project,
    name: 'casezap',
    'value.domain': req.body.value.domain,
    'value.token': req.body.value.token
  });
  if (intraDup) return res.status(409).json({ error: 'casezap_duplicate_instance_same_project' });
  ```
- Duplicate check cross-projeto: rejeita se mesmo `{value.domain, value.token}` existe em outro projeto (ja implementado)

**Non-platform (OpenAI, etc.):**
- Mantém `findOneAndUpdate` com upsert — sem mudanca

### PUT `/integration/:id`
- Remove `upsert: true` (fix seguranca)
- Atualiza por `_id`

### GET endpoints
- `GET /integration/name/:name` — mantém retorno single (backward-compat)
- `GET /integration/name/:name/instances` — NOVO, retorna array

### DELETE `/integration/:id`
- Funciona como esta (por `_id`)
- Antes de deletar: se casezap, chama cleanupWebhook diretamente (nao depende de integration.update event)

### Sanitizacao
- Todas as respostas filtram `webhookSecret` de `value` (ja implementado)

## CaseZap Connector

### Webhook Inbound

**Nova rota:** `POST /webhook/:integration_id?secret=X`
- Resolve Integration por `_id` (direto, sem ambiguidade)
- Valida `req.query.secret` contra `integration.value.webhookSecret`

**Rota antiga (fallback):** `POST /webhook/project/:project_id?secret=X`
- `findOne({id_project, name:'casezap'})` — funciona para single-instance
- Log de deprecation warning
- Permite migracao gradual sem quebrar instancias existentes

### Lead ID

Formato: `casezap-<integrationId>-<phone>`
- Ex: `casezap-69f090d8cbfe61-556284268492`
- Isola leads por instancia — mesmo telefone em 2 instancias = 2 leads separados

**Fallback para formato antigo:** Se `request.integrationId` e undefined (conversa antiga), outbound usa `leadId.replace('casezap-', '')` para extrair telefone. Se tem `integrationId`, usa `leadId.split('-').pop()`.

### Phone Extraction

```javascript
function extractPhoneFromLeadId(leadId, hasIntegrationId) {
  if (hasIntegrationId) {
    return leadId.split('-').pop();
  }
  return leadId.replace('casezap-', '');
}
```

### Request Creation

```javascript
var newRequest = {
  request_id: requestId,
  id_project: projectId,
  lead_id: lead._id,
  lead: lead,
  first_text: mapped.text || '',
  departmentid: defaultDept._id,
  integrationId: integration._id,          // NOVO
  channel: { name: ChannelConstants.CASEZAP },
  createdBy: mapped.leadId,
  attributes: {
    casezapPhone: mapped.phone,
    instanceLabel: instanceLabel            // NOVO - "Vendas (5581...920)"
  }
};
```

### Outbound Sender

```javascript
// Primeiro: tentar por integrationId (multi-instance)
var integrationId = message.request.integrationId;
var integration;
if (integrationId) {
  integration = await Integration.findById(integrationId);
} else {
  // Fallback: single-instance (conversas antigas)
  integration = await Integration.findOne({ id_project: projectId, name: 'casezap' });
}
```

Phone extraction com fallback:
```javascript
var phone;
if (integrationId) {
  phone = leadId.split('-').pop();
} else {
  phone = leadId.replace('casezap-', '');
}
```

### Connection Events

Handler usa `integration._id` (da URL) para update:
```javascript
await Integration.findByIdAndUpdate(integrationId, { $set: { 'value.status': newStatus } });
```

### Auto-webhook Registration

Rota muda de `/register/:project_id` para `/register/:integration_id`:
```javascript
router.post('/register/:integration_id', [passport.authenticate(...), validtoken], async function(req, res) {
  var integration = await Integration.findById(req.params.integration_id);
  // ... registerWebhook com integration._id na URL
});
```

### casezapProjects Map

Muda de `Map<projectId, {domain, token}>` para `Map<integrationId, {projectId, domain, token}>`:

```javascript
async function loadExistingProjects() {
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
}
```

### Integration Listener

Itera todas as instancias casezap no evento:
```javascript
integrationEvent.on('integration.update', function(integrations, projectId) {
  var czInstances = integrations.filter(function(i) { return i.name === 'casezap'; });
  // Atualizar Map para cada instancia
  var currentIds = new Set(czInstances.map(i => i._id.toString()));
  // Remover do Map as que nao existem mais (para este projeto)
  for (var [intId, data] of casezapProjects) {
    if (data.projectId === projectId && !currentIds.has(intId)) {
      cleanupWebhook(intId, data.domain, data.token, baseUrl);
      casezapProjects.delete(intId);
    }
  }
  // Adicionar/atualizar as que existem
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
```

## Dashboard

### Pagina `/casezap` — lista de instancias

Layout: lista de cards, cada card mostra nome, numero, dominio, status.
Botoes: [+ Adicionar instancia], [Editar], [Remover] por card.
Quota: "3/5 plataformas usadas" no topo.

### Fluxo Add
1. Click [+ Adicionar]
2. Form 4 campos (inline, toggle `list | add | edit`)
3. POST cria integration → retorna `_id`
4. Chama POST `/register/:integration_id`
5. Card aparece na lista

### Fluxo Edit
1. Click [Editar]
2. Form preenchido
3. PUT atualiza por `_id`
4. Chama POST `/register/:integration_id` (re-registra webhook)

### Fluxo Remove
1. Click [Remover] → modal de confirmacao
2. DELETE por `_id`
3. Card removido da lista

### API usada
- `GET /integration/name/casezap/instances` → array
- `POST /integration` → cria
- `PUT /integration/:id` → atualiza (novo metodo `updateIntegration` no IntegrationService)
- `DELETE /integration/:id` → remove

### Register fail handling
Se `/register` falha apos POST, status fica `pending`. Mostrar botao "Reconectar".

## Conversas — Display de Instancia

### CHANNELS_NAME
Adicionar entry `casezap` em `src/app/utils/util.ts`:
```javascript
CASEZAP: 'casezap'
```

### Tooltip nas listas de conversas
Icone: WhatsApp (verde, mesmo SVG)
Tooltip: "CaseZap - {instanceLabel}" (ex: "CaseZap - Vendas (5581...920)")

Locais a modificar:
- `ws-requests-unserved.component.html`
- `ws-requests-served.component.html`
- `history-and-nort-convs.component.html`
- `ws-requests-msgs.component.html` (detalhe)

### Instance label source
`request.attributes.instanceLabel` (usando `attributes` como ponto de extensao convencional do Tiledesk, nao `channel`).

## Migracao e Backward Compatibility

### Instancias existentes
- Schema nao muda — documentos existentes funcionam sem migracao
- Rota legacy `/webhook/project/:project_id` mantida como fallback (prefixo `project/` evita colisao com nova rota)
- Lead format antigo `casezap-<phone>` suportado via fallback no outbound

### Conversas existentes
- Requests sem `integrationId` usam fallback `findOne({id_project, name:'casezap'})`
- Phone extraction com fallback para formato antigo

### Sem migration script
- MongoDB aceita novos campos naturalmente
- Codigo trata campos novos como opcionais

## Arquivos a Modificar

### Server
| Arquivo | Mudanca |
|---|---|
| `models/integrations.js` | Sem mudanca de schema (usa _id existente) |
| `routes/integration.js` | POST bifurcado (create para PLATFORM_CHANNELS), remover findOne skip, novo GET instances, remover upsert do PUT, intra-project duplicate check |
| `pubmodules/casezap/connector.js` | Webhook `/webhook/:integration_id` + legacy `/webhook/project/:project_id`, outbound por integrationId com fallback, Map rekey por integration._id |
| `pubmodules/casezap/listener.js` | Sem mudanca significativa |
| `models/request.js` | Adicionar campo `integrationId: { type: Schema.Types.ObjectId, ref: 'integration', required: false }` |
| `services/requestService.js` | Adicionar `integrationId` ao destructuring (linha ~468) e ao constructor `new Request({...})` (linha ~623) |

### Dashboard
| Arquivo | Mudanca |
|---|---|
| `src/app/casezap/casezap.component.ts` | Rewrite ~80%: lista + add/edit toggle |
| `src/app/casezap/casezap.component.html` | Rewrite: cards + form |
| `src/app/casezap/casezap.component.scss` | Cards + responsivo |
| `src/app/services/integration.service.ts` | Adicionar `updateIntegration(id, data)` + `getIntegrationInstances(name)` |
| `src/app/utils/util.ts` | Adicionar CASEZAP ao CHANNELS_NAME |
| Conversation list templates (4 arquivos) | Adicionar tooltip CaseZap com instanceLabel |
