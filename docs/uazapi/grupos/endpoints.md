# Grupos e Comunidades — Endpoints

**Auth:** `token` em todos os endpoints desta seção.

---

## POST /group/create

Cria um novo grupo no WhatsApp.

**Request body:**
```json
{
  "name": "Equipe de Projeto",
  "participants": [
    "5521987905995",
    "5511912345678"
  ]
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `name` | string | sim | Nome do grupo (1-100 caracteres) |
| `participants` | array | sim | Lista de números de telefone (sem formatação, mínimo 1) |

**Response 200:** Retorna objeto `Group` (ver [schemas](../schemas/schemas.md#group)).

---

## POST /group/info

Retorna informações completas de um grupo.

**Request body:**
```json
{
  "groupjid": "redacted@example.invalid",
  "getInviteLink": true,
  "getRequestsParticipants": false,
  "force": false
}
```

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `groupjid` | string | JID do grupo (obrigatório) |
| `getInviteLink` | boolean | Recuperar link de convite |
| `getRequestsParticipants` | boolean | Recuperar lista de solicitações pendentes |
| `force` | boolean | Forçar atualização, ignorando cache |

**Response 200:**
```json
{
  "JID": "redacted@example.invalid",
  "Name": "uazapiGO Community",
  "Participants": [
    { "JID": "redacted@example.invalid", "IsAdmin": true }
  ],
  "IsLocked": false,
  "IsAnnounce": false
}
```

---

## POST /group/inviteInfo

Retorna informações de um grupo a partir de um código de convite, antes de entrar.

**Request body:**
```json
{
  "invitecode": "https://chat.whatsapp.com/IYnl5Zg9bUcJD32rJrDzO7"
}
```

Aceita o código curto (`IYnl5Zg9bUcJD32rJrDzO7`) ou a URL completa.

---

## POST /group/join

Entra em um grupo usando código de convite.

**Request body:**
```json
{
  "invitecode": "https://chat.whatsapp.com/IYnl5Zg9bUcJD32rJrDzO7"
}
```

**Response 200:**
```json
{
  "response": "Group join successful",
  "group": { ... },
  "needs_refresh": false
}
```

---

## POST /group/leave

Sai de um grupo.

**Request body:**
```json
{
  "groupjid": "redacted@example.invalid"
}
```

---

## GET /group/list

Lista todos os grupos em que o usuário é membro.

**Response 200:** Array de objetos `Group`.

---

## POST /community/create

Cria uma nova comunidade do WhatsApp.

**Request body:**
```json
{
  "name": "Minha Comunidade",
  "description": "Descrição da comunidade"
}
```

---

## POST /community/editgroups

Adiciona ou remove grupos de uma comunidade.

**Request body:**
```json
{
  "communityJID": "redacted@example.invalid",
  "groupJIDs": ["redacted@example.invalid"],
  "action": "add"
}
```

---

## Schema do Grupo

Ver [schemas/schemas.md](../schemas/schemas.md#group) para o schema completo do objeto `Group`, incluindo campos como `JID`, `Name`, `Topic`, `Participants`, `IsLocked`, `IsAnnounce`, `invite_link`, etc.
