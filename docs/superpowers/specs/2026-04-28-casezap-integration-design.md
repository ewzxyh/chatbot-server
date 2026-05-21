# Integração CaseZap (UazApi) — ChatCase SaaS

## Objetivo

Adicionar o canal **CaseZap** ao Tiledesk, permitindo conectar instâncias WhatsApp via UazApi (WhatsApp Web/QR Code) usando 4 campos: número, domínio da API, token da instância, nome da instância. Coexiste com o WhatsApp Oficial (Meta API) como canal separado.

## Contexto

- **UazApi**: Plataforma que conecta WhatsApp via Web/QR Code. API REST com autenticação por token no header.
- **CaseZap**: Plataforma do usuário que gerencia instâncias UazApi (gera QR code, retorna credenciais).
- **Fluxo do usuário**: Cria instância no CaseZap → escaneia QR code → recebe 4 credenciais → cola no ChatCase → pronto.
- O Tiledesk já tem WhatsApp Oficial via `@tiledesk/tiledesk-whatsapp-connector` (Meta API). O CaseZap é uma alternativa mais simples.

## Arquitetura

### Padrão de Conectores do Tiledesk

Cada canal externo segue o padrão:
- Pacote npm externo (`@tiledesk/tiledesk-<channel>-connector`)
- Wrapper fino em `pubmodules/<channel>/` (listener.js + index.js)
- Registrado em `pubModulesManager.js`, montado em `/modules/<channel>`
- Identidade do canal no Request model: `channel.name`, `channelOutbound.name`

### Desvio Intencional

O CaseZap é um **conector inline** — o código fica direto no repositório em vez de um pacote npm externo. Justificativa: é customizado para o ChatCase, não precisa de distribuição separada, e facilita iteração.

### Estrutura do Módulo

```
pubmodules/casezap/
├── index.js          — exporta { listener, casezapRoute }
├── listener.js       — Listener.listen(config), subscribe em message.sending
├── connector.js      — webhook handler inbound + sender outbound
└── messageMapper.js  — normalização UazApi ↔ Tiledesk
```

- Canal: `CASEZAP = 'casezap'` em `channelConstants.js`
- Quota: `'casezap'` em `PLATFORM_CHANNELS` e `CHANNEL_FLAG_MAP` em `routes/integration.js`
- Montado em `/modules/casezap` via `pubModulesManager.js`

## Integration Model

Credenciais armazenadas em `integration.value`:

```json
{
  "number": "5511999999999",
  "domain": "https://chatcase.uazapi.com",
  "token": "11053c0c-5250-42f7-8469-ea470a833dcc",
  "instanceName": "Gisana 1",
  "webhookSecret": "<uuid-v4-gerado-automaticamente>",
  "status": "active"
}
```

- `webhookSecret`: gerado pelo servidor no registro, usado na URL do webhook
- `status`: `active` | `disconnected`, atualizado via eventos `connection` da UazApi

## Variáveis de Ambiente

| Env Var | Obrigatória | Default | Descrição |
|---|---|---|---|
| `BASE_URL` | Sim | — | URL pública do servidor Tiledesk (já existe, usada por outros conectores). Usada na URL do webhook registrado na UazApi. |
| `CASEZAP_ENABLED` | Não | `true` | Habilita/desabilita o módulo CaseZap |

Nenhuma env var nova para credenciais — são por projeto via Integration model.

## Segurança

### Webhook Auth
URL inclui secret: `/modules/casezap/webhook/:project_id?secret=<webhookSecret>`.
O connector valida `req.query.secret` contra `integration.value.webhookSecret`.
O token da instância **nunca** é usado como auth no webhook — ele só serve para chamadas outbound à UazApi (header `token`).

### Proteção contra Duplicatas
No momento de criar/atualizar a integration `casezap`, o servidor verifica se já existe outra integration com o mesmo `domain + token` em outro projeto. Se existir, rejeita com HTTP 409.

### Deduplicação de Mensagens
Armazena `message.key.id` (ID único da UazApi) em cache LRU em memória (ou Redis SET com TTL de 1h). Se o ID já foi processado, ignora o webhook.

### Anti-loop via excludeMessages
O webhook registrado na UazApi inclui `excludeMessages: ["wasSentByApi", "isGroupYes"]`, que faz a UazApi não enviar de volta mensagens que foram enviadas pela própria API (evita loop) e filtra mensagens de grupos no nível da UazApi.

### Filtro de Grupos
Dupla proteção: `excludeMessages: ["isGroupYes"]` na UazApi + filtro no connector rejeitando JIDs `@g.us`. Tiledesk opera com conversas 1:1.

## Fluxo Inbound (WhatsApp → Tiledesk)

1. UazApi envia webhook POST → `/modules/casezap/webhook/:project_id?secret=xxx`
2. `connector.js` valida `req.query.secret` contra `integration.value.webhookSecret`
3. Filtra: `EventType === 'messages'`, ignora `fromMe`, rejeita `@g.us`
4. Verifica deduplicação via `message.key.id`
5. `messageMapper.js` normaliza UazApi → Tiledesk:
   - Sender: `casezap-<phone>` (phone extraído do JID, sem `@s.whatsapp.net`)
   - `channel.name = 'casezap'`
   - `channelOutbound.name = 'chat21'` (agentes veem no dashboard)
   - Request ID: `support-group-<project_id>-<uuid>`
   - Contato: `fullname = wa_name || contactName`, `phone` do JID
6. Cria/atualiza Request + Message via services internos do Tiledesk:
   - `requestService.createWithIdAndRequester()` para nova conversa
   - `messageService.send()` para adicionar mensagem

### Mapeamento de Tipos Inbound

| UazApi messageType | Tiledesk type | Campos |
|---|---|---|
| `conversation`, `extendedTextMessage` | `text` | `text` |
| `imageMessage` | `image` | `metadata.src` (URL da mídia) |
| `videoMessage` | `image` (type frame) | `metadata.src` |
| `audioMessage`, `ptt` | `file` | `metadata.src`, `metadata.type = audio` |
| `documentMessage` | `file` | `metadata.src`, `metadata.name` |
| `stickerMessage` | `image` | `metadata.src` |
| `locationMessage` | `text` | Texto formatado com lat/lng + link Google Maps |
| `contactMessage` | `text` | Texto formatado com nome + telefone |
| `reactionMessage` | ignorado no MVP | |

## Fluxo Outbound (Agente → WhatsApp via UazApi)

1. Agente responde no dashboard → Tiledesk cria mensagem
2. `connector.js` escuta `messageEvent.on('message.sending', ...)`
3. Filtro (seguindo padrão do `chat21Handler.js`):
   ```javascript
   message.status === MessageConstants.CHAT_MESSAGE_STATUS.SENDING
   && message.request.channel.name === 'casezap'
   && message.sender !== message.request.lead.lead_id
   ```
4. Busca Integration credentials do projeto
5. Verifica `integration.value.status === 'active'` — se `disconnected`, loga warning e não envia
6. `messageMapper.js` converte Tiledesk → UazApi
7. Chama endpoint UazApi com 1 retry e backoff de 2s
8. Destinatário: extrai phone de `casezap-<phone>` → formata como número para UazApi

### Mapeamento de Tipos Outbound

| Tiledesk type | UazApi endpoint | Campos |
|---|---|---|
| `text` | `POST /send/text` | `{ number, text }` |
| `image` | `POST /send/media` | `{ number, file: url, type: 'image', text: caption }` |
| `file` (audio) | `POST /send/media` | `{ number, file: url, type: 'audio' }` |
| `file` (document) | `POST /send/media` | `{ number, file: url, type: 'document', docName: filename }` |
| `frame` (video) | `POST /send/media` | `{ number, file: url, type: 'video' }` |
| buttons/quick replies | `POST /send/menu` | `{ number, type: 'button', text, choices: ['btn1', 'btn2'] }` |
| gallery/carousel | `POST /send/carousel` | `{ number, text, choices: ['[title]{imageUrl}[btn1]'] }` |

Header de autenticação UazApi: `token: <instance_token>` (nome exato do header: `token`).

## Eventos de Conexão

Quando UazApi envia `EventType: 'connection'`:
- `status: 'open'` → atualiza `integration.value.status = 'active'`
- `status: 'close'` → atualiza `integration.value.status = 'disconnected'`

## Auto-registro de Webhook

Quando integration `casezap` é criada/atualizada:
1. Gera `webhookSecret` (uuid v4) se não existir
2. Chama `POST {domain}/webhook` com header `token: <instance_token>`:
   ```json
   {
     "url": "{BASE_URL}/modules/casezap/webhook/{project_id}?secret={webhookSecret}",
     "enabled": true,
     "events": ["messages", "messages_update", "connection"],
     "excludeMessages": ["wasSentByApi", "isGroupYes"]
   }
   ```
3. Se falhar → retorna erro ao usuário com detalhes:
   - HTTP 401 da UazApi → token inválido → responde 400 "Token de instância inválido"
   - HTTP 429 da UazApi → instância no limite → responde 503 "Instância UazApi indisponível"
   - Timeout/network error → responde 502 "Não foi possível conectar ao domínio da API"
   - Sucesso → salva integration com webhookSecret e status 'active'

## Webhook Cleanup

Escuta `integrationEvent.on('integration.update', ...)`.
Mantém `Map<project_id, {domain, token}>` em memória para saber quais projetos tinham casezap.
Quando casezap desaparece da lista de integrations de um projeto:
1. Chama `POST {domain}/webhook` com header `token` e body `{ "action": "delete", "url": "..." }` na UazApi
2. Remove entrada do Map
3. Se a chamada falhar, loga warning mas não bloqueia a deleção

## Tratamento de Erros

### Outbound (envio para UazApi)
- **1 retry** com backoff de 2s para falhas de rede
- Se UazApi retornar 429 (rate limit): loga warning, não retenta
- Se instância `disconnected`: loga warning, não tenta enviar
- Mensagens que falham **não são reenfileiradas** — o agente verá que a mensagem foi enviada no dashboard mas o destinatário não receberá. Logs de erro no winston para troubleshooting.

### Inbound (webhook da UazApi)
- Webhook inválido (secret errado): responde 401, loga warning
- Payload malformado: responde 400, loga erro
- Erro interno no processamento: responde 500, loga erro com stack trace
- Sempre responde rapidamente (< 5s) para evitar timeout do webhook da UazApi

## Dashboard

- **Sidebar**: item "CaseZap" com ícone WhatsApp (verde)
- **Form de criação**: 4 campos obrigatórios:
  - Número do WhatsApp
  - Domínio da API (ex: https://chatcase.uazapi.com)
  - Token de instância
  - Nome da instância
- **Status**: badge verde (active) / vermelho (disconnected) baseado em `integration.value.status`
- Usa rotas existentes de integration (`POST /:projectid/integration`)

## Arquivos

### Criar
| Arquivo | Descrição |
|---|---|
| `pubmodules/casezap/index.js` | Exporta listener + route |
| `pubmodules/casezap/listener.js` | Inicializa conector, subscribe em events |
| `pubmodules/casezap/connector.js` | Webhook handler + sender |
| `pubmodules/casezap/messageMapper.js` | Normalização UazApi ↔ Tiledesk |

### Modificar
| Arquivo | Mudança |
|---|---|
| `models/channelConstants.js` | Adicionar `CASEZAP: 'casezap'` |
| `routes/integration.js` | Adicionar `'casezap'` em `PLATFORM_CHANNELS` e `CHANNEL_FLAG_MAP` |
| `pubmodules/pubModulesManager.js` | Registrar módulo casezap |

### Dashboard (C:\Users\enzo\tiledesk-dashboard)
| Arquivo | Mudança |
|---|---|
| Sidebar component | Adicionar item "CaseZap" |
| Integration setup component | Form com 4 campos + status badge |
