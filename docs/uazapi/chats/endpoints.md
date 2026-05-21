# Chats — Endpoints

**Auth:** `token` em todos os endpoints desta seção.

---

## POST /chat/find

Busca chats com filtros avançados, paginação e ordenação.

**Operadores de filtro no valor do campo:**
- `~valor` — LIKE (contém)
- `!~valor` — NOT LIKE (não contém)
- `!=valor` — diferente
- `>=valor`, `>valor`, `<=valor`, `<valor` — comparações numéricas
- Sem prefixo — LIKE (contém)

**Request body:**
```json
{
  "operator": "AND",
  "sort": "-wa_lastMsgTimestamp",
  "limit": 50,
  "offset": 0,
  "wa_isGroup": false,
  "lead_status": "~novo",
  "wa_notes": "~vip"
}
```

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `operator` | string | `AND` ou `OR` entre os filtros (padrão: `AND`) |
| `sort` | string | Campo de ordenação com prefixo `+` (asc) ou `-` (desc). Ex: `-wa_lastMsgTimestamp` |
| `limit` | integer | Quantidade máxima de resultados (padrão: 20) |
| `offset` | integer | Registros a pular para paginação (padrão: 0) |
| `wa_chatid` | string | ID do chat no WhatsApp |
| `wa_name` | string | Nome do perfil WhatsApp |
| `wa_contactName` | string | Nome salvo nos contatos |
| `name` | string | Nome consolidado |
| `wa_isGroup` | boolean | Filtra grupos |
| `wa_isGroup_admin` | boolean | Filtra grupos onde o usuário é admin |
| `wa_isGroup_member` | boolean | Filtra grupos onde o usuário é membro |
| `wa_isPinned` | boolean | Filtra chats fixados |
| `wa_archived` | boolean | Filtra chats arquivados |
| `wa_isBlocked` | boolean | Filtra contatos bloqueados |
| `wa_label` | string | ID da label aplicada ao chat |
| `wa_notes` | string | Filtra por anotações internas |
| `lead_tags` | string | Filtra por tags do lead |
| `lead_isTicketOpen` | boolean | Filtra leads com ticket aberto |
| `lead_assignedAttendant_id` | string | Filtra por atendente responsável |
| `lead_status` | string | Filtra por status do lead |

**Response 200:**
```json
{
  "chats": [ ... ],
  "totalChatsStats": { ... },
  "pagination": {
    "totalRecords": 150,
    "limit": 50,
    "offset": 0
  }
}
```

---

## POST /chat/details

Retorna detalhes completos de um chat específico, incluindo informações de lead e histórico.

**Request body:**
```json
{
  "number": "redacted@example.invalid"
}
```

---

## POST /chat/check

Verifica se números estão registrados no WhatsApp. Suporta múltiplos números e IDs de grupo simultaneamente.

- Para números individuais: verifica registro, retorna nome verificado quando disponível e normaliza o formato.
- Para grupos: verifica existência, retorna nome do grupo e, se for ID de comunidade, retorna o ID do grupo de anúncios associado.

**Request body:**
```json
{
  "numbers": ["5511999999999", "redacted@example.invalid"]
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `numbers` | array | sim | Lista de números (formato internacional) ou IDs de grupo (`@g.us`) |

---

## POST /chat/read

Marca um chat como lido.

**Request body:**
```json
{
  "number": "redacted@example.invalid"
}
```

---

## POST /chat/archive

Arquiva ou desarquiva um chat.

**Request body:**
```json
{
  "number": "redacted@example.invalid",
  "archive": true
}
```

---

## POST /chat/pin

Fixa ou desfixa um chat.

**Request body:**
```json
{
  "number": "redacted@example.invalid",
  "pin": true
}
```

---

## POST /chat/mute

Silencia ou remove silêncio de um chat.

**Request body:**
```json
{
  "number": "redacted@example.invalid",
  "mute": true,
  "muteEndTime": 1735689600
}
```

---

## POST /chat/delete

Deleta um chat.

**Request body:**
```json
{
  "number": "redacted@example.invalid"
}
```

---

## POST /chat/block

Bloqueia ou desbloqueia um contato.

**Request body:**
```json
{
  "number": "redacted@example.invalid",
  "block": true
}
```

---

## GET /chat/blocklist

Retorna a lista de contatos bloqueados.

---

## POST /chat/labels

Gerencia as etiquetas de um chat.

**Request body:**
```json
{
  "number": "redacted@example.invalid",
  "labelid": "10",
  "action": "add"
}
```

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `action` | string | `add` ou `remove` |
| `labelid` | string | ID da etiqueta (use `/labels` para listar) |

---

## POST /chat/notes

Consulta as notas internas de um chat usando dados locais persistidos.

**Request body:**
```json
{
  "number": "redacted@example.invalid"
}
```

**Response 200:**
```json
{
  "chat": { ... },
  "wa_notes": "Cliente prefere contato no período da tarde",
  "source": "local"
}
```

---

## POST /chat/notes/refresh

Recarrega as notas internas de um chat direto do WhatsApp.

**Request body:**
```json
{
  "number": "redacted@example.invalid",
  "force": false
}
```

Use `force: true` somente quando a recarga padrão não funcionar bem.

---

## POST /chat/notes/edit

Edita as notas internas de um chat.

**Request body:**
```json
{
  "number": "redacted@example.invalid",
  "notes": "Cliente VIP - prefere WhatsApp"
}
```

---

## GET /labels

Lista todas as etiquetas disponíveis.

---

## POST /label/edit

Cria, atualiza ou deleta uma etiqueta.

---

## GET /labels/refresh

Recarrega as etiquetas direto do WhatsApp.
