# Lessons

- Quando uma mensagem de canal externo chega mas nao aparece no `/chat/`, separar recepcao/persistencia do webhook de visibilidade no inbox humano. Confirmar `status`, `participantsAgents`, `participantsBots` e membros do grupo Chat21 antes de investigar resposta do bot.
- Para CaseZap, `tiledesk.messages` nao basta para a UI do atendente: o `/chat/` le o transcript em `chat21.messages`. Em bugs de visibilidade, validar as duas colecoes e o preview da request.
- Quando `/chat/` abre o ticket mas a timeline fica vazia, capture `/chatapi/api/tilechat/.../messages`: 403 aponta para JWT/Chat21, nao para webhook. No DEV, recriar `server`, `chat21httpserver` e `rabbitmq` com `--env-file .env.dev-vps` mantem `CHAT21_JWT_SECRET` alinhado.
