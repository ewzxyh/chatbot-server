# Plano: fluxos multicanal por padrao

## Objetivo

Voltar o modelo de fluxo para a proposta original do Tiledesk: o fluxo e multicanal por padrao, e o canal especifico so deve ser aplicado quando o usuario pedir explicitamente ou quando o template realmente for exclusivo de um canal.

## Passos

- [x] Remover a preferencia automatica por CaseZap no backend de templates.
- [x] Permitir importacao de template multicanal sem exigir `channel=casezap`.
- [x] Ajustar o dashboard/design studio para exibir `all`/multicanal por padrao.
- [x] Preservar filtro por compatibilidade quando o usuario escolher CaseZap, WABA ou outro canal.
- [x] Validar com testes unitarios dos templates.
- [x] Adaptar o executor do Tilebot para aplicar fallback textual quando uma acao WABA cair em conversa CaseZap.
- [ ] Corrigir visibilidade no `/chat/` quando mensagens CaseZap chegam mas o grupo Chat21 fica com preview antigo.
- [ ] Testar fluxo real com as instancias CaseZap Lovtok e markus-chatcase.

## Criterios de sucesso

- Template listado sem canal especifico nao recebe `targetChannel=casezap`.
- Importacao com canal `all` cria fluxo multicanal e abre o Studio sem badge fixa de CaseZap.
- Importacao com canal especifico nao transforma template generico em fluxo exclusivo.
- Nodes WABA continuam visiveis em fluxo multicanal para revisao explicita do usuario.
- Acao WABA com texto de fallback vira resposta normal em conversa CaseZap.
- Acao WABA continua nativa em conversa WABA/WhatsApp.
- Chat CaseZap continua recebendo e exibindo mensagens entre Lovtok e markus-chatcase.
