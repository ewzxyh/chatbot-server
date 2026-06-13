# Plano: fluxos multicanal por padrao

## Objetivo

Voltar o modelo de fluxo para a proposta original do Tiledesk: o fluxo e multicanal por padrao, e o canal especifico so deve ser aplicado quando o usuario pedir explicitamente ou quando o template realmente for exclusivo de um canal.

## Passos

- [x] Remover a preferencia automatica por CaseZap no backend de templates.
- [x] Permitir importacao de template multicanal sem exigir `channel=casezap`.
- [x] Ajustar o dashboard/design studio para exibir `all`/multicanal por padrao.
- [x] Preservar filtro por canal quando o usuario escolher CaseZap, WABA ou outro canal.
- [ ] Validar com testes unitarios dos templates e smoke na VPS DEV.
- [ ] Testar fluxo real com as instancias CaseZap Lovtok e markus-chatcase.

## Criterios de sucesso

- Template listado sem canal especifico nao recebe `targetChannel=casezap`.
- Importacao com canal `all` cria fluxo multicanal e abre o Studio sem badge fixa de CaseZap.
- Importacao com canal especifico continua reduzindo compatibilidade para aquele canal.
- Nodes WABA continuam visiveis em fluxo multicanal e bloqueados quando o canal explicito nao for WABA.
- Chat CaseZap continua recebendo e exibindo mensagens entre Lovtok e markus-chatcase.
