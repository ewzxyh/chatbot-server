# Enviar Mensagem — Endpoints

Endpoints para envio de mensagens com diferentes tipos de conteúdo.

**Auth:** `token` em todos os endpoints desta seção.

---

## Campos Opcionais Comuns

Todos os endpoints de envio suportam:

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `delay` | integer | Atraso em ms antes do envio. Mostra "Digitando..." ou "Gravando áudio..." durante o atraso. |
| `readchat` | boolean | Marca o chat como lido após envio. |
| `readmessages` | boolean | Marca as últimas 10 mensagens recebidas como lidas. |
| `replyid` | string | ID da mensagem para responder (cria resposta vinculada). |
| `viewOnce` | boolean | Mídia de visualização única. Funciona para `image`, `video`, `videoplay`, `ptv`, `audio`, `myaudio`, `ptt`. |
| `mentions` | string | Números para mencionar em grupos. Use `"all"` para todos ou `"5511999999999,5511888888888"`. |
| `forward` | boolean | Marca a mensagem como encaminhada. |
| `track_source` | string | Origem do rastreamento (ex: `"chatwoot"`). |
| `track_id` | string | ID para rastreamento em sistemas externos (aceita duplicados). |
| `async` | boolean | Envia via fila interna sem bloquear a requisição. Erros ficam em `/message/find` com `status=failed`. |

### Envio para Grupos

Use o `chatid` do grupo terminando em `@g.us` no campo `number`:
```
"number": "redacted@example.invalid"
```

### Placeholders

Use em qualquer campo de texto:
- `{{name}}` — nome consolidado do chat
- `{{first_name}}` — primeira palavra do nome consolidado
- `{{wa_name}}` — nome do perfil WhatsApp
- `{{wa_contactName}}` — nome salvo nos contatos
- `{{lead_name}}`, `{{lead_fullName}}`, `{{lead_email}}`, `{{lead_status}}`, `{{lead_notes}}`
- `{{lead_field01}}` a `{{lead_field20}}` (ou pelo nome configurado em `/instance/updateFieldsMap`)

---

## POST /send/text

Envia uma mensagem de texto.

**Request body:**
```json
{
  "number": "5511999999999",
  "text": "Olá {{name}}! Como posso ajudar?",
  "linkPreview": true,
  "linkPreviewTitle": "Título Personalizado",
  "linkPreviewDescription": "Uma descrição personalizada do link",
  "linkPreviewImage": "https://exemplo.com/imagem.jpg",
  "linkPreviewLarge": true,
  "delay": 1000
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `number` | string | sim | Número, ID de grupo (`@g.us`), newsletter (`@newsletter`) |
| `text` | string | sim | Texto da mensagem (aceita placeholders) |
| `linkPreview` | boolean | não | Ativa preview de link. `true` sozinho gera preview automático do primeiro link; forneça os campos personalizados para sobrescrever. |
| `linkPreviewTitle` | string | não | Título personalizado do preview |
| `linkPreviewDescription` | string | não | Descrição personalizada do preview |
| `linkPreviewImage` | string | não | URL ou base64 da imagem do preview |
| `linkPreviewLarge` | boolean | não | Preview grande com upload da imagem (`true`) ou preview pequeno sem upload (`false`) |

**Envio para newsletter:**
```json
{
  "number": "120363123456789012@newsletter",
  "text": "Post publicado no canal"
}
```

**Response 200:** Retorna objeto `Message` (ver [schemas](../schemas/schemas.md#message)).

---

## POST /send/media

Envia mídia (imagem, vídeo, áudio ou documento).

**Tipos suportados:**
- `image` — imagens (JPG recomendado)
- `video` — vídeos (apenas MP4)
- `videoplay` — vídeo com autoplay/loop no WhatsApp
- `document` — documentos (PDF, DOCX, XLSX, etc.)
- `audio` — áudio comum (MP3 ou OGG)
- `myaudio` — mensagem de voz
- `ptt` — mensagem de voz (Push-to-Talk)
- `ptv` — mensagem de vídeo (Push-to-Video)
- `sticker` — figurinha

**Request body:**
```json
{
  "number": "5511999999999",
  "type": "image",
  "file": "https://exemplo.com/imagem.jpg",
  "text": "Veja esta foto!",
  "docName": "relatorio.pdf",
  "thumbnail": "https://exemplo.com/thumb.jpg",
  "mimetype": "application/pdf",
  "viewOnce": false
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `number` | string | sim | Destinatário |
| `type` | string | sim | Tipo de mídia (`image`, `video`, `videoplay`, `document`, `audio`, `myaudio`, `ptt`, `ptv`, `sticker`) |
| `file` | string | sim | URL ou base64 do arquivo |
| `text` | string | não | Caption/legenda (aceita placeholders) |
| `docName` | string | não | Nome do arquivo (apenas para `document`) |
| `thumbnail` | string | não | URL ou base64 de thumbnail personalizado (vídeos e documentos) |
| `mimetype` | string | não | MIME type (detectado automaticamente se omitido) |
| `viewOnce` | boolean | não | Visualização única. Funciona para `image`, `video`, `videoplay`, `ptv`, `audio`, `myaudio`, `ptt`. Ignorado silenciosamente nos demais tipos. |

---

## POST /send/contact

Envia um cartão de contato (vCard) clicável para salvar na agenda.

**Request body:**
```json
{
  "number": "5511999999999",
  "fullName": "João Silva",
  "phoneNumber": "5511999999999,5511888888888",
  "organization": "Empresa XYZ",
  "email": "redacted@example.invalid",
  "url": "https://empresa.com/joao"
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `number` | string | sim | Destinatário (número, `@g.us`, `@s.whatsapp.net` ou `@lid`) |
| `fullName` | string | sim | Nome completo do contato |
| `phoneNumber` | string | sim | Número(s) de telefone. Separe múltiplos com vírgula. |
| `organization` | string | não | Nome da organização/empresa |
| `email` | string | não | Endereço de email |
| `url` | string | não | URL pessoal ou da empresa |

---

## POST /send/location

Envia uma localização geográfica com mapa interativo no WhatsApp.

**Request body:**
```json
{
  "number": "5511999999999",
  "latitude": -22.912982815767986,
  "longitude": -43.23028153499254,
  "name": "Maracanã",
  "address": "Av. Pres. Castelo Branco - Maracanã, Rio de Janeiro - RJ"
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `number` | string | sim | Destinatário (número, `@g.us`, `@s.whatsapp.net` ou `@lid`) |
| `latitude` | number | sim | Latitude (-90 a 90) |
| `longitude` | number | sim | Longitude (-180 a 180) |
| `name` | string | não | Nome do local exibido como pin no mapa |
| `address` | string | não | Endereço completo exibido abaixo do mapa |

---

## POST /send/menu

Envia menu interativo (lista ou botões).

**Request body — Lista:**
```json
{
  "number": "5511999999999",
  "type": "list",
  "text": "Escolha uma opção:",
  "buttonText": "Ver opções",
  "listButton": "Abrir lista",
  "footerText": "Selecione uma opção abaixo",
  "choices": ["Opção 1", "Opção 2", "Opção 3"]
}
```

**Request body — Botões:**
```json
{
  "number": "5511999999999",
  "type": "button",
  "text": "Escolha:",
  "footerText": "Toque em um botão",
  "choices": ["Sim", "Não", "Talvez"],
  "imageButton": "https://exemplo.com/imagem.jpg"
}
```

---

## POST /send/carousel

Envia mensagem em carrossel com múltiplos cards.

**Request body:**
```json
{
  "number": "5511999999999",
  "text": "Confira nossos produtos:",
  "choices": [
    "[Produto 1]{https://img.com/1.jpg}[Comprar][Saiba mais]",
    "[Produto 2]{https://img.com/2.jpg}[Comprar][Saiba mais]"
  ]
}
```

---

## POST /send/status

Envia uma atualização de status (story).

---

## POST /message/presence

Envia sinal de presença (digitando, gravando áudio).

**Request body:**
```json
{
  "number": "5511999999999",
  "presence": "composing"
}
```

Valores de `presence`: `composing`, `recording`, `paused`, `available`, `unavailable`

---

## Diagnóstico de Limites do WhatsApp

Quando o WhatsApp rejeitar envios por restrições de volume/qualidade, a resposta de erro 500 incluirá:

```json
{
  "error_source": "whatsapp_server",
  "provider": "whatsapp",
  "provider_code": 463,
  "error_key": "WHATSAPP_REACHOUT_TIMELOCK",
  "message": "The WhatsApp server rejected this message...",
  "message_ptbr": "O servidor do WhatsApp recusou esta mensagem...",
  "diagnostics_endpoint": "/instance/wa_messages_limits"
}
```

Use `GET /instance/wa_messages_limits` para ver o estado atual dos limites.
