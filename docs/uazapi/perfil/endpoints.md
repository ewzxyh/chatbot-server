# Perfil — Endpoints

Operações relacionadas ao perfil da conta WhatsApp atualmente conectada.

**Auth:** `token` em todos os endpoints desta seção.

---

## POST /profile/name

Altera o nome de exibição do perfil WhatsApp.

**Importante:**
- A conta deve estar conectada
- O nome será visível para todos os contatos
- Pode haver limite de alterações por período (conforme WhatsApp)

**Request body:**
```json
{
  "name": "Minha Empresa - Atendimento"
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `name` | string | sim | Novo nome do perfil (máximo 25 caracteres) |

**Response 200:**
```json
{
  "success": true,
  "message": "Nome do perfil alterado com sucesso",
  "profile": {
    "name": "Minha Empresa - Atendimento",
    "updated_at": 1704067200
  }
}
```

---

## POST /profile/image

Altera a imagem de perfil do WhatsApp.

**Formatos aceitos para `image`:**
- URL de imagem (`http://` ou `https://`)
- String base64 da imagem
- `"remove"` ou `"delete"` para remover a imagem atual

**Recomendação:** Imagem JPEG 640x640 pixels.

**Request body:**
```json
{
  "image": "https://picsum.photos/640/640.jpg"
}
```

**Response 200:**
```json
{
  "success": true,
  "message": "Imagem do perfil alterada com sucesso",
  "profile": {
    "image_updated": true,
    "image_removed": false,
    "updated_at": 1704067200
  }
}
```

---

## GET/POST /instance/privacy

Consulta (`GET`) ou atualiza (`POST`) as configurações de privacidade da conta.

Configurações disponíveis incluem visibilidade de: foto de perfil, status, horário online, etc.

---

## POST /instance/presence

Atualiza o status de presença da instância.

**Request body:**
```json
{
  "presence": "available"
}
```

| Valor | Descrição |
|-------|-----------|
| `available` | Online/disponível |
| `unavailable` | Offline |
