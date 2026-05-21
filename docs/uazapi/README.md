# uazapiGO - WhatsApp API v2

API para gerenciamento de instâncias do WhatsApp e comunicações.

## Recomendação Importante

**É ALTAMENTE RECOMENDADO usar contas do WhatsApp Business** em vez do WhatsApp normal para integração. O WhatsApp normal pode apresentar inconsistências, desconexões, limitações e instabilidades durante o uso com a API.

## Base URL

```
https://{subdomain}.uazapi.com
```

Subdomínios disponíveis:
- `free` (padrão) — servidor demo com restrições
- `api` — servidor de produção

## Autenticação

A API usa dois tipos de autenticação via header HTTP:

| Header | Uso |
|--------|-----|
| `token` | Endpoints regulares de instância. Valor obtido ao criar a instância. |
| `admintoken` | Endpoints administrativos (criação de instâncias, webhook global, restart). |

Exemplo:
```http
GET /instance/status HTTP/1.1
Host: api.uazapi.com
token: 123e4567-e89b-12d3-a456-426614174000
```

## Estados da Instância

| Estado | Descrição |
|--------|-----------|
| `disconnected` | Desconectado do WhatsApp |
| `connecting` | Em processo de conexão (aguardando QR code ou código de pareamento) |
| `connected` | Conectado e autenticado com sucesso |

## Limites de Uso

- O servidor possui um limite máximo de instâncias conectadas
- Quando o limite é atingido, novas tentativas recebem erro `429`
- Servidores gratuitos/demo podem ter restrições adicionais de tempo de vida

## Estrutura da Documentação

| Seção | Descrição |
|-------|-----------|
| [instancia/](./instancia/endpoints.md) | Ciclo de vida da instância: conectar, desconectar, status |
| [enviar-mensagem/](./enviar-mensagem/endpoints.md) | Envio de texto, mídia, contato, localização, menus, botões |
| [acoes-mensagem/](./acoes-mensagem/endpoints.md) | Reagir, deletar, editar, baixar, buscar mensagens |
| [webhook/](./webhook/endpoints.md) | Configuração de webhooks e SSE |
| [chats/](./chats/endpoints.md) | Operações em conversas: busca, labels, notas, arquivar |
| [contatos/](./contatos/endpoints.md) | Gerenciamento de contatos |
| [grupos/](./grupos/endpoints.md) | Criação e gerenciamento de grupos e comunidades |
| [perfil/](./perfil/endpoints.md) | Perfil da conta WhatsApp conectada |
| [admin/](./admin/endpoints.md) | Endpoints administrativos (requerem admintoken) |
| [mensagem-massa/](./mensagem-massa/endpoints.md) | Campanhas de envio em massa (sender) |
| [schemas/](./schemas/schemas.md) | Schemas de dados e payloads de webhook |

## Versão

API Version: **2.0.1**
