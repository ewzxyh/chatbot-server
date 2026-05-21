# Ações na Mensagem e Buscar — Endpoints

**Auth:** `token` em todos os endpoints desta seção.

---

## POST /message/find

Busca mensagens com múltiplos filtros. Resultados ordenados por data (mais recentes primeiro).

**Request body:**
```json
{
  "chatid": "redacted@example.invalid",
  "limit": 20,
  "offset": 0
}
```

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `id` | string | ID específico da mensagem para busca exata (formato: `owner:r3EB0538`) |
| `chatid` | string | ID do chat no WhatsApp (ex: `redacted@example.invalid`) |
| `track_source` | string | Filtra por origem de rastreamento |
| `track_id` | string | Filtra por ID de rastreamento |
| `limit` | integer | Máximo de mensagens a retornar (padrão: 100) |
| `offset` | integer | Deslocamento para paginação (padrão: 0) |

**Response 200:**
```json
{
  "returnedMessages": 20,
  "messages": [ ... ],
  "limit": 20,
  "offset": 0,
  "nextOffset": 20,
  "hasMore": true
}
```

---

## POST /message/history-sync

Solicita ao WhatsApp um sync sob demanda de mensagens antigas de um chat. As mensagens retornam via webhook/SSE em eventos do tipo `history` e ficam disponíveis em `/message/find`.

**Importante:** a recuperação pode só acontecer depois de abrir o WhatsApp no celular ou deixá-lo ativo em segundo plano.

**Request body:**
```json
{
  "number": "redacted@example.invalid",
  "messageid": "3EB01234567890ABCDEF",
  "count": 20
}
```

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `number` | string | JID completo do chat |
| `messageid` | string | ID da mensagem de referência (busca mensagens anteriores a ela) |
| `count` | integer | Quantidade desejada (máx: 100) |

---

## POST /message/markread

Marca uma ou mais mensagens como lidas e sincroniza o status entre dispositivos.

**Request body:**
```json
{
  "id": [
    "62AD1AD844E518180227BF68DA7ED710",
    "ECB9DE48EB41F77BFA8491BFA8D6EF9B"
  ]
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `id` | array | sim | Lista de IDs das mensagens a marcar como lidas |

**Response 200:**
```json
{
  "success": true,
  "message": "Messages marked as read",
  "markedMessages": [
    { "id": "62AD1AD844E518180227BF68DA7ED710", "timestamp": 1672531200000 },
    { "id": "ECB9DE48EB41F77BFA8491BFA8D6EF9B", "timestamp": 1672531300000 }
  ]
}
```

---

## POST /message/react

Envia uma reação (emoji) a uma mensagem. Para remover uma reação, envie `text` vazio.

**Request body:**
```json
{
  "number": "redacted@example.invalid",
  "text": "👍",
  "id": "3EB0538DA65A59F6D8A251"
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `number` | string | sim | JID do chat |
| `text` | string | sim | Emoji Unicode ou string vazia para remover reação |
| `id` | string | sim | ID da mensagem que receberá a reação |

**Limitações:**
- Só é possível reagir a mensagens de outros usuários
- Não é possível reagir a mensagens com mais de 7 dias
- Um usuário só pode ter uma reação ativa por mensagem

---

## POST /message/delete

Deleta uma mensagem.

**Request body:**
```json
{
  "id": "3EB0538DA65A59F6D8A251",
  "number": "redacted@example.invalid"
}
```

---

## POST /message/edit

Edita o texto de uma mensagem enviada.

**Request body:**
```json
{
  "id": "3EB0538DA65A59F6D8A251",
  "number": "redacted@example.invalid",
  "text": "Texto editado da mensagem"
}
```

---

## POST /message/pin

Fixa ou desfixa uma mensagem no chat.

**Request body:**
```json
{
  "number": "redacted@example.invalid",
  "id": "3EB0538DA65A59F6D8A251",
  "pin": true,
  "duration": 86400
}
```

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `pin` | boolean | `true` para fixar, `false` para desafixar |
| `duration` | integer | Duração em segundos (ex: 86400 = 24h) |

---

## POST /message/download

Faz download do conteúdo de mídia de uma mensagem (imagem, vídeo, áudio, documento ou sticker) e retorna como URL pública e/ou base64. Suporta transcrição de áudio via OpenAI.

| Campo | Tipo | Padrão | Descrição |
|-------|------|--------|-----------|
| `id` | string | — | ID da mensagem contendo o arquivo (obrigatório) |
| `return_base64` | boolean | `false` | Retorna o conteúdo em base64 |
| `return_link` | boolean | `true` | Salva e retorna URL pública do arquivo |
| `generate_mp3` | boolean | `true` | Para áudios: `true` retorna MP3, `false` retorna OGG |
| `transcribe` | boolean | `false` | Transcreve áudios para texto (requer chave OpenAI) |
| `openai_apikey` | string | — | Chave OpenAI para transcrição. Se informada, é salva na instância para próximas chamadas. |
| `download_quoted` | boolean | `false` | Baixa a mídia da mensagem citada em vez da principal. Útil para recuperar a mídia original quando o usuário responde a um status. |

**Exemplos:**

```json
{ "id": "7EB0F01D7244B421048F0706368376E0", "generate_mp3": true }
```
```json
{ "id": "7EB0F01D7244B421048F0706368376E0", "transcribe": true }
```
```json
{ "id": "7EB0F01D7244B421048F0706368376E0", "return_base64": true, "return_link": false }
```
```json
{ "id": "7EB0F01D7244B421048F0706368376E0", "download_quoted": true }
```

**Response 200:**
```json
{
  "fileURL": "https://api.exemplo.com/files/arquivo.mp3",
  "mimetype": "audio/mpeg",
  "base64Data": "UklGRkj...",
  "transcription": "Texto transcrito"
}
```

**Notas:**
- Por padrão, áudios são retornados como MP3 e todos os downloads retornam URL pública.
- Transcrição requer chave OpenAI válida. A chave pode ser configurada uma vez na instância e é reutilizada automaticamente.
- Retenção de mídia: arquivos ficam disponíveis por 2 dias no storage. Após esse prazo são removidos; novo download rebaixa a mídia do CDN da Meta (pode ser mais lento).

---

## GET/POST /message/async

**GET** — Consulta o estado atual da fila interna de envio assíncrono.

**POST** — Controla a fila: limpa backlog pendente e cancela mensagens ainda não enviadas.

> Escopo: apenas a fila interna de mensagens diretas com `async=true`. Não cobre campanhas do sender (`/sender/*`).
