# Multi-Instance WhatsApp Oficial (Meta) — Design Spec

## Objetivo

Permitir multiplas instancias WhatsApp Business API (Meta) por projeto no ChatCase. Cada instancia (numero/WABA) consome 1 slot da quota de plataformas. Inclui internalizacao do conector npm para controle total do codigo.

## Escopo

- Internalizar `@tiledesk/tiledesk-whatsapp-connector` como modulo local em `pubmodules/whatsapp/connector/`
- Suportar N numeros WhatsApp por projeto via kvstore keyed por `waba_id`
- Corrigir outbound routing para multi-instance
- Adicionar duplicate detection por `phone_number_id`
- Dashboard: lista de instancias conectadas

## Decisoes de Design

- Fork interno (copiar pacote npm para dentro do repo) — controle total, sem dependencia externa
- kvstore continua como source of truth para config do conector (tokens, phone_number_id, etc.)
- Dual-write: OAuth callback TAMBEM cria documento na `integrations` collection (para duplicate check, GET /instances, quota counting)
- Manter AMBOS os padroes de key no kvstore (`whatsapp-{waba_id}` para OAuth, `whatsapp-{project_id}` para legacy manual)
- Mongoose do conector mantem-se isolado (v6, via dbconnection passado pelo server)
- Duplicate detection por `phone_number_id` (mesmo numero no mesmo projeto = 409)
- Permitir numeros diferentes da mesma WABA (caso de uso: vendas + suporte)

## Internalizacao do Conector

### Estrutura

```
pubmodules/whatsapp/
  ├── index.js              — exporta { listener, whatsappRoute } (ja existe, sem mudanca)
  ├── listener.js           — muda require para './connector' em vez de '@tiledesk/...'
  └── connector/            — NOVO: copia do pacote npm
      ├── index.js           — main (1894 linhas, rotas + startApp)
      ├── tiledesk/          — 15 classes (Channel, Whatsapp, Utils, KVBase, etc.)
      ├── routes/            — api.js
      ├── template/          — 5 HTML templates (configure.html, etc.)
      ├── models/            — Transaction.js, WhatsappLog.js
      ├── utils/             — 2 files
      ├── assets/i18n/       — traducoes
      └── package.json       — dependencias do conector
```

### Mudancas no listener.js

```javascript
// ANTES
const whatsapp = require("@tiledesk/tiledesk-whatsapp-connector");

// DEPOIS
const whatsapp = require("./connector");
```

### Dependencias

O conector traz suas proprias dependencias via seu `node_modules/`. A camada de dados (KVBaseMongo) usa raw MongoDB driver via `dbconnection` passado pelo server — nao usa Mongoose. Porem, o conector faz `mongoose.connect()` separado para logging (WhatsappLog model, Mongoose v6). Esse connection e isolado e nao conflita com o server (v5). Nao precisa de mudanca no server's package.json.

### Index necessario no kvstore

Para `getByField('phone_number_id', ...)` performar bem:
```javascript
db.kvstore.createIndex({ 'value.phone_number_id': 1 })
```

### Remover do package.json do server

Remover `"@tiledesk/tiledesk-whatsapp-connector"` das dependencias.

## kvstore Keys

### Padroes coexistentes

| Fluxo | Key pattern | Quando |
|---|---|---|
| OAuth (Embedded Signup) | `whatsapp-{waba_id}` | Novas conexoes via dashboard |
| Manual (legacy) | `whatsapp-{project_id}` | Setups antigos sem OAuth |

Nao forcar migracao. O lookup tenta ambos com fallback.

### Lookup order (Utils.js getSettings)

```javascript
async getSettings(project_id, waba_id) {
  if (waba_id) {
    let settings = await db.get('whatsapp-' + waba_id);
    if (settings) return settings;
  }
  return await db.get('whatsapp-' + project_id);
}
```

### Nova funcao: getSettingsByPhoneNumberId

```javascript
async getSettingsByPhoneNumberId(phone_number_id) {
  // Query kvstore by value field
  return await db.getByField('phone_number_id', phone_number_id);
}
```

Requer adicionar `getByField()` ao KVBaseMongo:
```javascript
async getByField(field, value) {
  let query = {};
  query['value.' + field] = value;
  let doc = await this.collection.findOne(query);
  return doc ? doc.value : null;
}
```

## Dual-Write: OAuth Callback → kvstore + integrations

O OAuth callback (`/onboarding/callback`) atualmente salva APENAS no kvstore. Para multi-instance funcionar com duplicate check e GET /instances, deve TAMBEM criar um documento na collection `integrations`:

```javascript
// No /onboarding/callback, apos salvar no kvstore:
let integrationData = {
  id_project: project_id,
  name: 'whatsapp',
  value: {
    phone_number_id: phone_number_id,
    waba_id: waba_id,
    phone_number: phone_number,
    verified_name: verified_name
  }
};
// POST para Tiledesk API ou insert direto
await axios.post(API_URL + '/' + project_id + '/integration', integrationData, { headers: { Authorization: token } });
```

Isso garante:
- `GET /integration/name/whatsapp/instances` retorna a lista de numeros conectados
- Duplicate check por `phone_number_id` na collection `integrations` funciona
- Quota counting inclui WhatsApp
- Consistencia com o padrao CaseZap

## Webhook Inbound

### POST /webhook (OAuth path) — sem mudanca

Ja roteia por `waba_id`:
```javascript
let waba_id = req.body.entry[0].id;
let settings = await db.get('whatsapp-' + waba_id);
```
Multi-instance ready. Cada WABA tem sua propria entry no kvstore.

### POST /webhook/:project_id (legacy) — deprecation warning

Mantido para backward compat. Faz `getSettingsByProjectId()` que retorna o primeiro match. Funciona para projetos single-instance.

```javascript
winston.warn('WhatsApp: legacy webhook route. Migrate to OAuth.');
```

## Webhook Handler — Salvar waba_id e phone_number_id no Request

Quando o webhook cria um request no Tiledesk, salvar nos attributes:
```javascript
attributes.waba_id = waba_id;
attributes.whatsapp_phone_number_id = phone_number_id;
```

Isso permite o outbound resolver a instancia correta sem parsing do recipient string.

IMPORTANTE: O conector NAO cria requests diretamente — ele chama `POST /:project_id/requests/:request_id/messages` via HTTP (TiledeskChannel.send()). Os attributes sao passados no body da mensagem. Para que `waba_id` chegue ao request, modificar `TiledeskChannel.send()` para incluir esses campos nos attributes do body:

```javascript
// Em TiledeskChannel.send() ou sendAndAddBot():
attributes.waba_id = waba_id;
attributes.whatsapp_phone_number_id = phone_number_id;
```

O Tiledesk server propaga attributes da mensagem para o request na criacao.

## Outbound

### POST /tiledesk (resposta do agente) — fix principal

```javascript
// ANTES (quebra com multi-instance):
let settings = await utils.getSettingsByProjectId(project_id);

// DEPOIS:
let phone_number_id = extractPhoneNumberId(req.body);
let settings;
if (phone_number_id) {
  settings = await utils.getSettingsByPhoneNumberId(phone_number_id);
}
if (!settings) {
  settings = await utils.getSettingsByProjectId(project_id); // fallback legacy
}
```

### Extracao de phone_number_id

O `phone_number_id` e extraido do recipient string usando substring entre "wab-" e o ultimo "-":
```javascript
// Codigo real do conector (linha 618):
let phone_number_id = message_info.attributes.whatsapp_phone_number_id 
  || recipient.substring(recipient.lastIndexOf("wab-") + 4, recipient.lastIndexOf("-"));
```

Preferencia: usar `message_info.attributes.whatsapp_phone_number_id` (setado pelo webhook handler). Fallback: parsing do recipient.

### POST /tiledesk/broadcast — precisa de phone_number_id

```javascript
// Broadcast agora aceita phone_number_id como parametro
let phone_number_id = req.body.phone_number_id;
let settings;
if (phone_number_id) {
  settings = await utils.getSettingsByPhoneNumberId(phone_number_id);
} else {
  settings = await db.get('whatsapp-' + project_id); // fallback: primeiro numero
}
```

### GET /direct/tiledesk — mesmo fix

Aceitar `phone_number_id` como query param. Fallback para `whatsapp-{project_id}`.

## Duplicate Detection

No `routes/integration.js`, adicionar check para WhatsApp:

```javascript
if (req.body.name === 'whatsapp' && req.body.value && req.body.value.phone_number_id) {
    try {
        let dup = await Integration.findOne({
            id_project: id_project,
            name: 'whatsapp',
            'value.phone_number_id': req.body.value.phone_number_id
        });
        if (dup) {
            return res.status(409).json({
                error: 'whatsapp_duplicate_number',
                message: 'This WhatsApp number is already connected in this project'
            });
        }
    } catch (dupErr) {
        winston.error('Error checking WhatsApp duplicate', dupErr);
    }
}
```

## Dashboard

### configure.html (agora interno)

O template do Embedded Signup esta em `pubmodules/whatsapp/connector/template/configure.html`. Com a internalizacao, pode ser customizado livremente:
- Traduzir para PT-BR
- Alterar cores/layout
- Adicionar lista de instancias conectadas
- Mostrar status por instancia

### Lista de instancias

Apos o Embedded Signup, o template deve mostrar uma lista de numeros conectados ao projeto:
- Nome verificado
- Numero
- Status (connected/disconnected)
- Botao remover

A lista e obtida via `GET /integration/name/whatsapp/instances` (endpoint ja existe).

## Backward Compatibility

### Projetos single-instance existentes

- kvstore entries com key `whatsapp-{project_id}` continuam funcionando
- Webhook legacy (`/webhook/:project_id`) mantido com deprecation
- Outbound fallback para `getSettingsByProjectId()` para conversas sem `waba_id` nos attributes
- Sem migration script necessario

### Conversas existentes

- Requests antigos sem `attributes.waba_id` usam fallback `getSettingsByProjectId()`
- Funciona enquanto o projeto tiver apenas 1 instancia (caso atual)

## Arquivos a Modificar

### Server

| Arquivo | Mudanca |
|---|---|
| `pubmodules/whatsapp/listener.js` | Mudar require para './connector' |
| `pubmodules/whatsapp/connector/` | NOVO: copia do pacote npm |
| `pubmodules/whatsapp/connector/index.js` | Outbound fix (lookup por phone_number_id), salvar waba_id nos attributes do request |
| `pubmodules/whatsapp/connector/tiledesk/Utils.js` | Adicionar getSettingsByPhoneNumberId() |
| `pubmodules/whatsapp/connector/tiledesk/KVBaseMongo.js` | Adicionar getByField() |
| `pubmodules/whatsapp/connector/template/configure.html` | Scopes OAuth (ja corrigido via sed, agora permanente) |
| `routes/integration.js` | Adicionar duplicate check para whatsapp (phone_number_id) |
| `package.json` | Remover @tiledesk/tiledesk-whatsapp-connector |
| `Dockerfile` | Remover o sed patch de scopes (agora e codigo interno) |

### Dashboard

| Arquivo | Mudanca |
|---|---|
| Template configure.html (interno) | Customizacao visual, PT-BR, lista de instancias |
