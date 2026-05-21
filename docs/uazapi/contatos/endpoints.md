# Contatos — Endpoints

**Auth:** `token` em todos os endpoints desta seção.

---

## GET /contacts

Retorna a lista de contatos do WhatsApp.

**Query parameters:**

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `contactScope` | string | `address_book` (padrão), `outside_address_book`, `all` |

**Response 200:**
```json
[
  {
    "jid": "redacted@example.invalid",
    "contactName": "João Silva",
    "contact_FirstName": "João"
  }
]
```

---

## POST /contacts/list

Retorna lista paginada de contatos com controle via corpo da requisição.

**Request body:**
```json
{
  "limit": 100,
  "offset": 0,
  "contactScope": "address_book"
}
```

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `limit` | integer | Máximo de resultados por página (padrão: 100, máximo: 1000) |
| `offset` | integer | Deslocamento para paginação (padrão: 0) |
| `contactScope` | string | `address_book`, `outside_address_book` ou `all` |

**Response 200:**
```json
{
  "contacts": [
    {
      "jid": "redacted@example.invalid",
      "contact_name": "Joao Silva",
      "contact_FirstName": "Joao"
    }
  ],
  "totalDeviceContacts": 500,
  "pagination": {
    "totalRecords": 500,
    "limit": 100,
    "offset": 0
  }
}
```

---

## POST /contact/add

Adiciona um novo contato à agenda do celular.

**Request body:**
```json
{
  "number": "5521999999999",
  "name": "João Silva"
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `number` | string | sim | Número internacional (ex: `5521999999999`). Aceita variações com/sem `+`, parênteses, hífen. Também aceita JID (`@s.whatsapp.net`). |
| `name` | string | sim | Nome completo do contato |

**Response 200:**
```json
{
  "success": true,
  "message": "Contato adicionado com sucesso",
  "contact": {
    "jid": "redacted@example.invalid",
    "name": "João Silva",
    "phone": "5521999999999"
  }
}
```

---

## POST /contact/remove

Remove um contato da agenda do celular.

**Request body:**
```json
{
  "number": "5521999999999"
}
```

**Response 200:**
```json
{
  "success": true,
  "message": "Contato removido com sucesso"
}
```
