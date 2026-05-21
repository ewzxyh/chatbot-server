# Mensagem em Massa — Endpoints (Sender)

Controles para campanhas de envio em massa com delay entre mensagens e agendamento.

**Auth:** `token` em todos os endpoints desta seção.

---

## POST /sender/simple

Cria uma nova campanha de envio simples.

**Request body:**
```json
{
  "numbers": [
    "redacted@example.invalid",
    "redacted@example.invalid"
  ],
  "type": "text",
  "text": "Olá {{name}}! Temos uma novidade para você.",
  "folder": "Campanha Janeiro",
  "delayMin": 10,
  "delayMax": 30,
  "scheduled_for": 1706198400000
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `numbers` | array | sim | Lista de JIDs dos destinatários |
| `type` | string | sim | Tipo da mensagem: `text`, `image`, `video`, `videoplay`, `audio`, `document`, `contact`, `location`, `list`, `button`, `poll`, `carousel` |
| `delayMin` | integer | sim | Delay mínimo entre mensagens em segundos |
| `delayMax` | integer | sim | Delay máximo entre mensagens em segundos |
| `scheduled_for` | integer | sim | Timestamp Unix (ms) ou minutos a partir de agora |
| `folder` | string | não | Nome da campanha |
| `info` | string | não | Informações adicionais |
| `text` | string | não | Texto da mensagem (para `type: text`) |
| `file` | string | não | URL da mídia (para tipos de mídia) |
| `docName` | string | não | Nome do arquivo (para `document`) |
| `linkPreview` | boolean | não | Habilitar preview de links |

**Campos por tipo de mensagem:**

Para `contact`: `fullName`, `phoneNumber`, `organization`, `email`, `url`

Para `location`: `latitude`, `longitude`, `name`, `address`

Para `list`, `button`, `poll`, `carousel`: `footerText`, `buttonText`, `choices` (array de strings), `listButton`, `selectableCount`, `imageButton`

**Response 200:**
```json
{
  "folder_id": "abc123",
  "count": 150,
  "status": "queued"
}
```

---

## POST /sender/advanced

Cria um envio em massa avançado com múltiplas mensagens diferentes por destinatário.

**Request body:**
```json
{
  "delayMin": 3,
  "delayMax": 6,
  "folder": "Campanha Avançada",
  "scheduled_for": 1706198400000,
  "messages": [
    {
      "number": "redacted@example.invalid",
      "type": "text",
      "text": "Olá João! Mensagem personalizada."
    },
    {
      "number": "redacted@example.invalid",
      "type": "image",
      "file": "https://exemplo.com/img.jpg",
      "text": "Confira esta imagem!"
    }
  ]
}
```

---

## POST /sender/edit

Edita uma campanha existente (antes de ser executada).

---

## POST /sender/cleardone

Remove mensagens já concluídas de uma pasta de campanha.

---

## POST /sender/clearall

Remove todas as mensagens de uma pasta de campanha.

---

## GET /sender/listfolders

Lista todas as pastas (campanhas) de mensagens em massa.

**Response 200:** Array de objetos `MessageQueueFolder`.

```json
[
  {
    "id": "pasta_abc123",
    "info": "Campanha Janeiro",
    "status": "ativo",
    "scheduled_for": 1706198400000,
    "delayMin": 10000,
    "delayMax": 30000,
    "log_total": 150,
    "log_sucess": 140,
    "log_failed": 10,
    "log_read": 80,
    "log_delivered": 130,
    "created": "2024-01-25T10:00:00.000Z"
  }
]
```

---

## POST /sender/listmessages

Lista as mensagens de uma pasta específica.

**Request body:**
```json
{
  "folder_id": "pasta_abc123",
  "limit": 50,
  "offset": 0
}
```

---

## Evento Webhook `sender`

Quando uma campanha inicia ou completa, o webhook dispara o evento `sender` com informações sobre o andamento.

Configure `"events": ["sender"]` no webhook para receber essas notificações.
