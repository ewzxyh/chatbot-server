# Administração — Endpoints

Endpoints que requerem `admintoken` para autenticação.

**Auth:** `admintoken` em todos os endpoints desta seção.

---

## POST /instance/create

Cria uma nova instância do WhatsApp. Ver documentação completa em [instancia/endpoints.md](../instancia/endpoints.md#post-instancecreate).

---

## GET /instance/all

Lista todas as instâncias do sistema.

**Response 200:** Array de objetos `Instance`.

```json
[
  {
    "id": "r183e2ef9597845",
    "name": "instancia-1",
    "token": "abc123xyz",
    "status": "connected",
    "profileName": "Meu WhatsApp",
    "profilePicUrl": "https://example.com/profile.jpg",
    "isBusiness": true,
    "plataform": "Android",
    "created": "2024-01-01T12:00:00.000Z"
  },
  {
    "id": "r283e2ef9597846",
    "name": "instancia-2",
    "token": "def456xyz",
    "status": "disconnected",
    "lastDisconnect": "2024-01-02T12:00:00.000Z",
    "lastDisconnectReason": "manual disconnect"
  }
]
```

---

## POST /instance/updateAdminFields

Atualiza os campos administrativos (`adminField01` / `adminField02`) de uma instância.

Esses campos são visíveis para o dono da instância via `token`, mas apenas o administrador pode editá-los.

**Request body:**
```json
{
  "id": "inst_123456",
  "adminField01": "clientId_456",
  "adminField02": "integration_xyz"
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `id` | string | sim | ID da instância |
| `adminField01` | string | não | Campo administrativo 1 |
| `adminField02` | string | não | Campo administrativo 2 |

**Response 200:** Objeto `Instance` atualizado.

---

## GET /globalwebhook

Retorna a configuração atual do webhook global (eventos de todas as instâncias). Ver [webhook/endpoints.md](../webhook/endpoints.md#get-globalwebhook).

---

## POST /globalwebhook

Configura o webhook global. Ver [webhook/endpoints.md](../webhook/endpoints.md#post-globalwebhook).

---

## GET /globalwebhook/errors

Retorna os últimos 20 erros de entrega do webhook global. Ver [webhook/endpoints.md](../webhook/endpoints.md#get-globalwebhookerrors).

---

## POST /admin/restart

Reinicia toda a aplicação para forçar a reconexão de todas as instâncias. Use apenas em situações de instabilidade geral.

Após o restart, os números entram em reconexão automática e não ficam desconectados permanentemente.

**Response 202:**
```json
{
  "message": "Restart agendado com sucesso"
}
```
