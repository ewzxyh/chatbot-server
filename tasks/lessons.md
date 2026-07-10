# Lessons

- Quando uma mensagem de canal externo chega mas nao aparece no `/chat/`, separar recepcao/persistencia do webhook de visibilidade no inbox humano. Confirmar `status`, `participantsAgents`, `participantsBots` e membros do grupo Chat21 antes de investigar resposta do bot.
- Para CaseZap, `tiledesk.messages` nao basta para a UI do atendente: o `/chat/` le o transcript em `chat21.messages`. Em bugs de visibilidade, validar as duas colecoes e o preview da request.
- Quando `/chat/` abre o ticket mas a timeline fica vazia, capture `/chatapi/api/tilechat/.../messages`: 403 aponta para JWT/Chat21, nao para webhook. No DEV, recriar `server`, `chat21httpserver` e `rabbitmq` com `--env-file .env.dev-vps` mantem `CHAT21_JWT_SECRET` alinhado.
- Em contratos administrativos que emitem JWT, validar o status ativo do recurso raiz e retornar o TTL numerico junto do token para o cliente representar a expiracao sem inferencia.
- Claims privilegiadas so devem chegar ao contexto da requisicao depois de validar uso reservado, audiencia, formato e consistencia com a identidade efetiva; assinatura valida sozinha nao define a procedencia da claim.
- Antes de criar um plano em `tasks/todo.md`, verificar se o arquivo ja tem historico local e acrescentar uma secao sem substituir tarefas anteriores.
