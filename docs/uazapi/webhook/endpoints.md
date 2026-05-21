# Webhook e SSE — Endpoints

---

## GET /webhook

**Auth:** `token`

Retorna a configuração atual dos webhooks da instância. A resposta é sempre um array.

**Response 200:**
```json
[
  {
    "id": "123e4567-e89b-12d3-a456-426614174000",
    "enabled": true,
    "url": "https://example.com/webhook",
    "events": ["messages", "messages_update"],
    "excludeMessages": ["wasSentByApi", "isGroupNo"],
    "addUrlEvents": true,
    "addUrlTypesMessages": true
  }
]
```

---

## POST /webhook

**Auth:** `token`

Configura ou atualiza webhooks para receber eventos em tempo real. Suporta múltiplos webhooks por instância via campo `action`/`id`.

**Sites para testar webhooks durante desenvolvimento** (por ordem de qualidade):
1. https://webhook.cool/ — melhor opção (sem rate limit, interface limpa)
2. https://rbaskets.in/ — boa alternativa (confiável, baixo rate limit)
3. https://webhook.site/ — evitar se possível (rate limit agressivo)

### Modo Simples (Recomendado)

Não inclua `action` nem `id` — gerencia automaticamente um único webhook.

```json
{
  "enabled": true,
  "url": "https://meusite.com/webhook",
  "events": ["messages", "connection"],
  "excludeMessages": ["wasSentByApi"]
}
```

### Modo Avançado (múltiplos webhooks)

Antes de criar múltiplos webhooks, considere usar `addUrlEvents` no modo simples: um único webhook pode receber diferentes tipos de eventos em URLs distintas (ex: `/webhook/messages`, `/webhook/connection`), eliminando a necessidade de múltiplos registros.

```json
{
  "action": "add",
  "enabled": true,
  "url": "https://api.exemplo.com/webhook",
  "events": ["messages", "groups"],
  "excludeMessages": ["wasSentByApi"]
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `url` | string | sim | URL de destino dos eventos |
| `events` | array | sim | Lista de tipos de evento a monitorar |
| `enabled` | boolean | não | Ativa/desativa (padrão: `true`) |
| `excludeMessages` | array | não | Filtros de exclusão |
| `addUrlEvents` | boolean | não | Adiciona tipo do evento como path na URL |
| `addUrlTypesMessages` | boolean | não | Adiciona tipo da mensagem como path na URL |
| `action` | string | não | `add`, `update` ou `delete` (modo avançado) |
| `id` | string | não | ID do webhook (obrigatório para `update`/`delete`) |

### Eventos Disponíveis

| Evento | Descrição |
|--------|-----------|
| `connection` | Alterações no estado da conexão |
| `history` | Recebimento de histórico de mensagens ao conectar |
| `messages` | Novas mensagens recebidas |
| `messages_update` | Atualizações em mensagens (status de leitura, entrega) |
| `newsletter_messages` | Novos posts em canais do WhatsApp |
| `call` | Eventos de chamadas VoIP |
| `contacts` | Atualizações na agenda de contatos |
| `presence` | Alterações no status de presença (online/offline) |
| `groups` | Modificações em grupos |
| `labels` | Gerenciamento de etiquetas |
| `chats` | Eventos de conversas |
| `chat_labels` | Alterações em etiquetas de conversas |
| `blocks` | Bloqueios/desbloqueios de contatos |
| `sender` | Atualizações de campanhas de mensagem em massa |

### Filtros de Exclusão (`excludeMessages`)

| Filtro | Descrição |
|--------|-----------|
| `wasSentByApi` | Exclui mensagens enviadas via API. **Use sempre para evitar loops.** |
| `wasNotSentByApi` | Exclui mensagens não enviadas via API |
| `fromMeYes` | Exclui mensagens enviadas pelo usuário |
| `fromMeNo` | Exclui mensagens recebidas de terceiros |
| `isGroupYes` | Exclui mensagens de grupos |
| `isGroupNo` | Exclui mensagens de conversas individuais |

### URLs Dinâmicas

Com `addUrlEvents: true` e/ou `addUrlTypesMessages: true`, a URL do webhook recebe sufixos dinâmicos:

- Apenas `addUrlEvents`: `https://meusite.com/webhook/messages`
- Apenas `addUrlTypesMessages`: `https://meusite.com/webhook/conversation`
- Ambos: `https://meusite.com/webhook/messages/conversation`

Isso permite um único webhook receber todos os eventos em endpoints separados.

---

## GET /webhook/errors

**Auth:** `token`

Retorna os últimos 20 erros de entrega dos webhooks locais da instância autenticada (mantido apenas em memória, perdido ao reiniciar).

**Response 200:**
```json
[
  {
    "created": "2026-03-23T15:04:05Z",
    "url": "https://example.com/webhook/messages",
    "type": "local",
    "event": "messages",
    "message_type": "text",
    "status_code": 502,
    "attempts": 3,
    "error": "webhook returned non-success status: 502 Bad Gateway",
    "payload": { "EventType": "messages", "token": "instance-token" }
  }
]
```

---

## GET /globalwebhook

**Auth:** `admintoken`

Retorna a configuração atual do webhook global (recebe eventos de todas as instâncias).

---

## POST /globalwebhook

**Auth:** `admintoken`

Configura o webhook global.

```json
{
  "url": "https://webhook.cool/global",
  "events": ["messages", "connection"],
  "excludeMessages": ["wasSentByApi"]
}
```

---

## GET /globalwebhook/errors

**Auth:** `admintoken`

Retorna os últimos 20 erros de entrega do webhook global.

---

## GET /sse

**Auth:** `token`

Server-Sent Events — stream de eventos em tempo real da instância. Alternativa aos webhooks para receber eventos via conexão HTTP persistente.
