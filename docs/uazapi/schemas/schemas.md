# Schemas e Payloads de Webhook

Esta seção documenta os schemas de dados retornados pela API e, **principalmente**, os payloads enviados pelo UazApi quando eventos ocorrem (mensagens chegando, atualizações de status, conexão, etc.).

---

## Payload de Webhook — Formato Geral

O UazApi envia um `POST` HTTP para a URL configurada no webhook. O corpo é JSON.

O campo chave é `EventType` que identifica o tipo do evento. O `token` identifica qual instância gerou o evento.

```json
{
  "EventType": "messages",
  "token": "123e4567-e89b-12d3-a456-426614174000",
  ...campos específicos do evento
}
```

---

## Evento: `messages` — Nova Mensagem

Disparado quando uma nova mensagem é recebida ou enviada.

```json
{
  "EventType": "messages",
  "token": "123e4567-e89b-12d3-a456-426614174000",
  "id": "owner:r3EB0538",
  "messageid": "3EB0538DA65A59F6D8A251",
  "chatid": "redacted@example.invalid",
  "sender": "redacted@example.invalid",
  "senderName": "João Silva",
  "isGroup": false,
  "fromMe": false,
  "messageType": "conversation",
  "source": "android",
  "messageTimestamp": 1706198400000,
  "status": "Delivered",
  "text": "Olá, preciso de ajuda!",
  "quoted": "",
  "reaction": "",
  "wasSentByApi": false,
  "content": {
    "conversation": "Olá, preciso de ajuda!"
  }
}
```

### Campos do Evento `messages`

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `EventType` | string | Sempre `"messages"` |
| `token` | string | Token da instância que gerou o evento |
| `id` | string | ID interno da mensagem no formato `owner:rXXXXXX` |
| `messageid` | string | ID original da mensagem no WhatsApp |
| `chatid` | string | ID do chat (ex: `redacted@example.invalid` ou `redacted@example.invalid`) |
| `sender` | string | JID do remetente |
| `senderName` | string | Nome exibido do remetente |
| `isGroup` | boolean | `true` se for mensagem de grupo |
| `fromMe` | boolean | `true` se a mensagem foi enviada pela instância |
| `messageType` | string | Tipo de conteúdo (ver tabela abaixo) |
| `source` | string | Plataforma de origem (`android`, `ios`, `web`) |
| `messageTimestamp` | integer | Timestamp em milissegundos |
| `status` | string | Status da mensagem (`Queued`, `Sent`, `Delivered`, `Read`, `Failed`) |
| `text` | string | Texto da mensagem (quando disponível) |
| `quoted` | string | ID da mensagem citada/respondida |
| `reaction` | string | ID da mensagem reagida (para eventos de reação) |
| `vote` | string | Dados de votação (para enquetes/listas) |
| `wasSentByApi` | boolean | `true` se enviada via API |
| `sendFunction` | string | Nome da função usada para enviar (quando via API) |
| `fileURL` | string | URL do arquivo de mídia |
| `content` | object | Conteúdo bruto da mensagem (estrutura varia por tipo) |
| `track_source` | string | Origem do rastreamento (se definido no envio) |
| `track_id` | string | ID de rastreamento (se definido no envio) |
| `sender_pn` | string | JID PN resolvido do remetente |
| `sender_lid` | string | LID original do remetente |

### Valores de `messageType`

| Valor | Descrição |
|-------|-----------|
| `conversation` | Texto simples |
| `extendedTextMessage` | Texto com preview de link |
| `imageMessage` | Imagem |
| `videoMessage` | Vídeo |
| `audioMessage` | Áudio/voz (ptt) |
| `documentMessage` | Documento |
| `stickerMessage` | Figurinha/sticker |
| `locationMessage` | Localização |
| `contactMessage` | Contato |
| `reactionMessage` | Reação a mensagem |
| `pollCreationMessage` | Criação de enquete |
| `pollUpdateMessage` | Atualização de enquete (voto) |
| `listMessage` | Mensagem de lista |
| `listResponseMessage` | Resposta de lista |
| `buttonsMessage` | Mensagem de botões |
| `buttonsResponseMessage` | Resposta de botões |
| `templateMessage` | Template de mensagem |
| `groupInviteMessage` | Convite de grupo |
| `protocolMessage` | Protocolo (deletar/editar) |
| `ephemeralMessage` | Mensagem efêmera (temporária) |
| `viewOnceMessage` | Mensagem de visualização única |
| `orderMessage` | Pedido (WhatsApp Business) |
| `productMessage` | Produto (WhatsApp Business) |

---

## Evento: `messages_update` — Atualização de Status

Disparado quando o status de uma mensagem muda (enviada, entregue, lida).

```json
{
  "EventType": "messages_update",
  "token": "123e4567-e89b-12d3-a456-426614174000",
  "id": "owner:r3EB0538",
  "messageid": "3EB0538DA65A59F6D8A251",
  "chatid": "redacted@example.invalid",
  "status": "Read",
  "fromMe": true,
  "messageTimestamp": 1706198400000
}
```

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `EventType` | string | Sempre `"messages_update"` |
| `token` | string | Token da instância |
| `id` | string | ID interno da mensagem |
| `messageid` | string | ID original no WhatsApp |
| `chatid` | string | ID do chat |
| `status` | string | Novo status: `Sent`, `Delivered`, `Read`, `Played` |
| `fromMe` | boolean | Se foi enviada pela instância |

---

## Evento: `connection` — Estado da Conexão

Disparado quando o estado de conexão da instância muda.

```json
{
  "EventType": "connection",
  "token": "123e4567-e89b-12d3-a456-426614174000",
  "status": "connected",
  "instance": {
    "id": "r183e2ef9597845",
    "name": "minha-instancia",
    "status": "connected",
    "profileName": "Loja ABC",
    "profilePicUrl": "https://example.com/profile.jpg",
    "isBusiness": true
  }
}
```

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `EventType` | string | Sempre `"connection"` |
| `token` | string | Token da instância |
| `status` | string | `connected`, `disconnected`, `connecting` |
| `instance` | object | Dados atuais da instância |

---

## Evento: `history` — Histórico de Mensagens

Disparado durante a sincronização inicial após conectar ou ao solicitar histórico via `/message/history-sync`. Contém array de mensagens históricas.

```json
{
  "EventType": "history",
  "token": "123e4567-e89b-12d3-a456-426614174000",
  "messages": [
    {
      "id": "owner:r3EB0538",
      "messageid": "3EB0538DA65A59F6D8A251",
      "chatid": "redacted@example.invalid",
      "messageType": "conversation",
      "text": "Mensagem histórica",
      "messageTimestamp": 1706198400000,
      "fromMe": false
    }
  ]
}
```

---

## Evento: `presence` — Status de Presença

Disparado quando o status online/offline de um contato muda.

```json
{
  "EventType": "presence",
  "token": "123e4567-e89b-12d3-a456-426614174000",
  "chatid": "redacted@example.invalid",
  "presence": "available",
  "lastSeen": 1706198400
}
```

---

## Evento: `chats` — Eventos de Conversas

Disparado quando um chat é criado, atualizado ou deletado.

```json
{
  "EventType": "chats",
  "token": "123e4567-e89b-12d3-a456-426614174000",
  "action": "update",
  "chat": {
    "wa_chatid": "redacted@example.invalid",
    "name": "João Silva",
    "wa_lastMsgTimestamp": 1706198400000,
    "wa_unreadCount": 3
  }
}
```

---

## Evento: `groups` — Modificações em Grupos

Disparado quando um grupo é criado, modificado ou quando participantes são alterados.

```json
{
  "EventType": "groups",
  "token": "123e4567-e89b-12d3-a456-426614174000",
  "action": "participants",
  "group": {
    "JID": "redacted@example.invalid",
    "Name": "Meu Grupo"
  },
  "participants": ["redacted@example.invalid"],
  "participantAction": "add"
}
```

---

## Evento: `contacts` — Atualização de Contatos

Disparado quando contatos da agenda são atualizados.

---

## Evento: `labels` — Etiquetas

Disparado quando etiquetas são criadas, atualizadas ou deletadas.

---

## Evento: `chat_labels` — Etiquetas de Chat

Disparado quando etiquetas são adicionadas ou removidas de conversas.

---

## Evento: `call` — Chamadas

Disparado quando uma chamada de voz/vídeo é recebida ou encerrada.

```json
{
  "EventType": "call",
  "token": "123e4567-e89b-12d3-a456-426614174000",
  "callId": "ABCDEF123456",
  "from": "redacted@example.invalid",
  "status": "ringing",
  "isVideo": false
}
```

---

## Evento: `blocks` — Bloqueios

Disparado quando um contato é bloqueado ou desbloqueado.

---

## Evento: `sender` — Campanhas

Disparado quando uma campanha de mensagem em massa inicia ou completa.

---

## Evento: `newsletter_messages` — Posts de Canais

Disparado quando novos posts são publicados em canais/newsletters seguidos.

---

## Schema: Instance

```json
{
  "id": "r183e2ef9597845",
  "token": "abc123xyz",
  "status": "connected",
  "paircode": "1234-5678",
  "qrcode": "data:image/png;base64,...",
  "name": "Instância Principal",
  "profileName": "Loja ABC",
  "profilePicUrl": "https://example.com/profile.jpg",
  "isBusiness": true,
  "plataform": "Android",
  "systemName": "uazapi",
  "owner": "redacted@example.invalid",
  "lastDisconnect": "2025-01-24T14:00:00Z",
  "lastDisconnectReason": "Network error",
  "adminField01": "custom_data",
  "openai_apikey": "sk-...xyz",
  "chatbot_enabled": true,
  "chatbot_ignoreGroups": true,
  "chatbot_stopConversation": "parar",
  "chatbot_stopMinutes": 60,
  "created": "2025-01-24T14:00:00Z",
  "updated": "2025-01-24T14:30:00Z",
  "current_presence": "available"
}
```

---

## Schema: Message

```json
{
  "id": "owner:r3EB0538",
  "messageid": "3EB0538DA65A59F6D8A251",
  "chatid": "redacted@example.invalid",
  "sender": "redacted@example.invalid",
  "senderName": "João Silva",
  "isGroup": false,
  "fromMe": false,
  "messageType": "conversation",
  "source": "android",
  "messageTimestamp": 1706198400000,
  "status": "Delivered",
  "text": "Olá!",
  "quoted": "",
  "edited": "",
  "reaction": "",
  "vote": "",
  "wasSentByApi": false,
  "sendFunction": "",
  "fileURL": "",
  "track_source": "",
  "track_id": "",
  "content": { "conversation": "Olá!" },
  "sendPayload": null,
  "ai_metadata": null,
  "sender_pn": "redacted@example.invalid",
  "sender_lid": ""
}
```

### Campos do Schema Message

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `id` | string | ID interno formato `owner:rXXXXXX` |
| `messageid` | string | ID original da mensagem no WhatsApp |
| `chatid` | string | ID completo do chat no WhatsApp |
| `sender` | string | JID do remetente |
| `senderName` | string | Nome exibido do remetente |
| `isGroup` | boolean | Indica se é mensagem de grupo |
| `fromMe` | boolean | Indica se foi enviada pela instância |
| `messageType` | string | Tipo de conteúdo da mensagem |
| `source` | string | Plataforma de origem |
| `messageTimestamp` | integer | Timestamp em milissegundos |
| `status` | string | `Queued`, `Canceled`, `Failed`, `Sent`, `Delivered`, `Read` |
| `text` | string | Texto da mensagem |
| `quoted` | string | ID da mensagem citada |
| `edited` | string | Histórico de edições |
| `reaction` | string | ID da mensagem reagida |
| `vote` | string | Dados de votação de enquetes/listas |
| `buttonOrListid` | string | ID do botão ou item de lista selecionado |
| `wasSentByApi` | boolean | Se foi enviada via API |
| `sendFunction` | string | Função usada para enviar (quando via API) |
| `fileURL` | string | URL ou referência do arquivo de mídia |
| `track_source` | string | Origem do rastreamento |
| `track_id` | string | ID de rastreamento |
| `content` | object/string | Conteúdo bruto da mensagem |
| `sendPayload` | object/string | Payload original de envio |
| `ai_metadata` | object | Metadados de processamento por IA |
| `sender_pn` | string | JID PN resolvido do remetente |
| `sender_lid` | string | LID original do remetente |

---

## Schema: Chat

```json
{
  "id": "r1234abcd",
  "wa_fastid": "owner:5511999999999",
  "wa_chatid": "redacted@example.invalid",
  "wa_chatlid": "",
  "wa_archived": false,
  "wa_contactName": "João Silva",
  "wa_name": "João",
  "name": "João Silva",
  "image": "https://pps.whatsapp.net/...",
  "imagePreview": "https://pps.whatsapp.net/...",
  "wa_isBlocked": false,
  "wa_isGroup": false,
  "wa_isGroup_admin": false,
  "wa_isGroup_announce": false,
  "wa_isGroup_community": false,
  "wa_isGroup_member": false,
  "wa_isPinned": false,
  "wa_label": [],
  "wa_notes": "",
  "wa_lastMessageType": "conversation",
  "wa_lastMsgTimestamp": 1706198400000,
  "wa_lastMessageSender": "redacted@example.invalid",
  "wa_muteEndTime": 0,
  "wa_unreadCount": 0,
  "wa_ephemeralExpiration": 0,
  "phone": "5511999999999",
  "owner": "redacted@example.invalid",
  "lead_name": "",
  "lead_fullName": "",
  "lead_email": "",
  "lead_personalid": "",
  "lead_status": "",
  "lead_tags": [],
  "lead_notes": "",
  "lead_isTicketOpen": false,
  "lead_assignedAttendant_id": "",
  "lead_kanbanOrder": 0,
  "lead_field01": "",
  "chatbot_disableUntil": 0
}
```

### Campos Importantes do Schema Chat

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `wa_chatid` | string | ID completo do chat no WhatsApp (use este para enviar mensagens) |
| `wa_fastid` | string | ID rápido do WhatsApp |
| `wa_contactName` | string | Nome salvo na agenda da instância |
| `wa_name` | string | Nome do perfil WhatsApp ("push name") |
| `name` | string | Nome consolidado (melhor disponível entre os anteriores) |
| `wa_isGroup` | boolean | Se é um grupo |
| `wa_isGroup_admin` | boolean | Se a instância é admin do grupo |
| `phone` | string | Número de telefone |
| `wa_lastMsgTimestamp` | integer | Timestamp da última mensagem |
| `wa_unreadCount` | integer | Contador de mensagens não lidas |
| `wa_label` | array | IDs das etiquetas aplicadas |
| `wa_notes` | string | Anotações internas sincronizadas via app state |
| `lead_*` | string/array/boolean | Campos de CRM do lead |
| `lead_field01`-`lead_field20` | string | Campos personalizados (mapeados via `/instance/updateFieldsMap`) |

---

## Schema: Webhook (Configuração)

```json
{
  "id": "wh_9a8b7c6d5e",
  "enabled": true,
  "url": "https://webhook.cool/example",
  "events": ["messages", "newsletter_messages", "connection"],
  "addUrlTypesMessages": false,
  "addUrlEvents": false,
  "excludeMessages": []
}
```

---

## Schema: Group

```json
{
  "JID": "redacted@example.invalid",
  "OwnerJID": "redacted@example.invalid",
  "Name": "Grupo de Suporte",
  "Topic": "Descrição do grupo",
  "IsLocked": true,
  "IsAnnounce": false,
  "IsEphemeral": false,
  "DisappearingTimer": 0,
  "IsParent": false,
  "GroupCreated": "2024-01-01T12:00:00Z",
  "MemberAddMode": "all_member_add",
  "OwnerCanSendMessage": true,
  "OwnerIsAdmin": true,
  "invite_link": "https://chat.whatsapp.com/XXXXX",
  "Participants": [
    {
      "JID": "redacted@example.invalid",
      "IsAdmin": true,
      "IsSuperAdmin": false
    }
  ]
}
```

---

## Schema: Label

```json
{
  "id": "l121314mnop",
  "name": "Cliente VIP",
  "color": 2,
  "colorHex": "#fed428",
  "labelid": "10",
  "owner": "redacted@example.invalid",
  "created": "2025-01-24T14:35:00.000Z",
  "updated": "2025-01-24T15:00:00.000Z"
}
```

Cores disponíveis (índice 0-19): `#ff9484`, `#64c4ff`, `#fed428`, `#dfaef0`, `#9ab6c1`, `#56ccb4`, `#fe9dfe`, `#d3a91f`, `#6f7bcf`, `#d8e651`, `#01d0e2`, `#ffc5c7`, `#92ceac`, `#f64847`, `#00a1f2`, `#83e421`, `#ffae04`, `#b4ebff`, `#9ba6ff`, `#9568cf`

---

## Schema: MessageQueueFolder (Campanha)

```json
{
  "id": "pasta_abc123",
  "info": "Campanha Janeiro",
  "status": "ativo",
  "scheduled_for": 1706198400000,
  "delayMax": 30000,
  "delayMin": 10000,
  "log_delivered": 130,
  "log_failed": 10,
  "log_played": 5,
  "log_read": 80,
  "log_sucess": 140,
  "log_total": 150,
  "owner": "redacted@example.invalid",
  "created": "2024-01-25T10:00:00.000Z",
  "updated": "2024-01-25T12:00:00.000Z"
}
```

---

## Notas sobre IDs no WhatsApp

| Formato | Uso |
|---------|-----|
| `redacted@example.invalid` | Chat individual (número brasileiro) |
| `redacted@example.invalid` | Grupo |
| `120363123456789012@newsletter` | Canal/Newsletter |
| `5511999999999@lid` | ID local (contas com LID) |

Para enviar mensagens, use o `wa_chatid` do chat como campo `number`.
