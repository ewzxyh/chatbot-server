# Instância — Endpoints

Operações relacionadas ao ciclo de vida de uma instância WhatsApp.

---

## POST /instance/create

**Auth:** `admintoken`

Cria uma nova instância do WhatsApp. Após criar, guarde o `token` retornado — ele é necessário para todas as outras operações.

**Request body:**
```json
{
  "name": "minha-instancia",
  "systemName": "apilocal",
  "adminField01": "custom-metadata-1",
  "adminField02": "custom-metadata-2"
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `name` | string | sim | Nome da instância |
| `systemName` | string | não | Nome do sistema (padrão: `uazapiGO`) |
| `adminField01` | string | não | Campo administrativo 1 para metadados personalizados |
| `adminField02` | string | não | Campo administrativo 2 para metadados personalizados |

**Response 200:**
```json
{
  "response": "Instance created successfully",
  "instance": { ... },
  "connected": false,
  "loggedIn": false,
  "name": "minha-instancia",
  "token": "123e4567-e89b-12d3-a456-426614174000",
  "info": "This instance will be automatically disconnected and deleted after 1 hour."
}
```

---

## POST /instance/connect

**Auth:** `token`

Inicia o processo de conexão ao WhatsApp.

- Se enviar `phone`: gera código de pareamento
- Se omitir `phone`: gera QR code

O processo aguarda até 2 minutos (QR) ou 5 minutos (código de pareamento). Use `/instance/status` para monitorar o progresso.

**Sincronização de mensagens ao conectar:**
- Mensagens recebidas da Meta durante a sincronização do QR code são enviadas no evento `history` do webhook.
- Mensagens dos últimos 7 dias são armazenadas no banco e acessíveis via `POST /message/find` e `POST /chat/find`.
- Após conectar, todas as mensagens enviadas ou recebidas são armazenadas continuamente.
- Mensagens com mais de 7 dias são excluídas automaticamente durante a madrugada.

**Request body:**
```json
{
  "phone": "5511999999999"
}
```

**Response 200:**
```json
{
  "connected": false,
  "loggedIn": false,
  "jid": null,
  "instance": { ... }
}
```

---

## POST /instance/disconnect

**Auth:** `token`

Desconecta a conta do WhatsApp, encerrando a sessão atual. Requer novo QR code para reconectar.

**Response 200:**
```json
{
  "instance": { ... },
  "response": "Disconnected",
  "info": "The device has been successfully disconnected from WhatsApp. A new QR code will be required for the next connection."
}
```

---

## POST /instance/reset

**Auth:** `token`

Solicita reset controlado do runtime da instância. Útil quando a sessão ficou presa ou o envio não está progredindo.

**Response 200:**
```json
{
  "response": "Instance reset started",
  "resetting": true,
  "instanceId": "r183e2ef9597845",
  "queuedRecoveryAttempted": true
}
```

---

## GET /instance/status

**Auth:** `token`

Retorna o status atual da instância. Inclui:
- Estado da conexão (`disconnected`, `connecting`, `connected`)
- QR code atualizado (se em processo de conexão via QR)
- Código de pareamento (se disponível)
- Informações da última desconexão
- Detalhes completos da instância

Útil para monitorar o progresso durante o fluxo de conexão.

**Response 200:**
```json
{
  "instance": {
    "id": "r183e2ef9597845",
    "name": "minha-instancia",
    "status": "connected",
    "profileName": "Meu WhatsApp",
    "currentTime": "2024-01-25T12:00:00.000Z"
  },
  "status": {
    "connected": true,
    "loggedIn": true,
    "jid": {
      "user": "5511999999999",
      "agent": 0,
      "device": 0,
      "server": "s.whatsapp.net"
    }
  }
}
```

---

## DELETE /instance

**Auth:** `token`

Remove a instância do sistema.

**Response 200:**
```json
{
  "response": "Instance Deleted",
  "info": "O dispositivo foi desconectado com sucesso e a instância foi removida do banco de dados."
}
```

---

## GET /instance/wa_messages_limits

**Auth:** `token`

Consulta o estado atual de limitação do WhatsApp para a conta conectada. Útil para diagnosticar erros com `provider_code: 463`.

**Response 200:**
```json
{
  "provider": "whatsapp",
  "reachable": true,
  "can_send_new_messages": false,
  "error_key": "WHATSAPP_REACHOUT_TIMELOCK",
  "message": "WhatsApp indicates that the currently connected account is under a temporary restriction...",
  "message_ptbr": "O WhatsApp indica que a conta atualmente conectada está sob uma restrição temporária...",
  "diagnostics_endpoint": "/instance/wa_messages_limits",
  "new_chat_message_capping": {
    "available": true,
    "status": "CAPPED",
    "used_quota": 10,
    "total_quota": 10
  },
  "reachout_timelock": {
    "available": true,
    "active": true,
    "until": "2026-04-07T12:00:00Z",
    "enforcement_type": "BIZ_QUALITY"
  }
}
```

---

## POST /instance/updateInstanceName

**Auth:** `token`

Atualiza o nome de uma instância existente. O nome não precisa ser único.

**Request body:**
```json
{
  "name": "Minha Nova Instância 2024"
}
```

---

## GET /instance/privacy

**Auth:** `token`

Busca configurações de privacidade da instância.

---

## POST /instance/updateFieldsMap

**Auth:** `token` (tag CRM)

Configura os nomes dos campos personalizados de leads (lead_field01 a lead_field20), que depois podem ser referenciados em placeholders por nome.

**Request body:**
```json
{
  "lead_field01": "nome",
  "lead_field02": "email",
  "lead_field03": "telefone"
}
```

---

## GET/POST /instance/proxy

**Auth:** `token`

- `GET`: Retorna configuração atual de proxy e resultado do último teste de conectividade.
- `POST`: Configura proxy próprio via `proxy_url` ou volta ao proxy interno padrão.

**Request body (POST):**
```json
{
  "proxy_url": "[REDACTED_BASIC_AUTH_URL]"
}
```

**Notas sobre proxy:**
- IPs padrão são brasileiros. Para clientes internacionais, configure um proxy da região do cliente.
- Você pode usar um celular Android como proxy via app disponível em https://github.com/uazapi/silver_proxy_apk
