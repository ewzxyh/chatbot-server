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
- [x] Corrigir visibilidade no `/chat/` quando mensagens CaseZap chegam mas o grupo Chat21 fica com preview antigo.
- [x] Testar troca real de mensagens com as instancias CaseZap Lovtok e markus-chatcase.

## Criterios de sucesso

- Template listado sem canal especifico nao recebe `targetChannel=casezap`.
- Importacao com canal `all` cria fluxo multicanal e abre o Studio sem badge fixa de CaseZap.
- Importacao com canal especifico nao transforma template generico em fluxo exclusivo.
- Nodes WABA continuam visiveis em fluxo multicanal para revisao explicita do usuario.
- Acao WABA com texto de fallback vira resposta normal em conversa CaseZap.
- Acao WABA continua nativa em conversa WABA/WhatsApp.
- Chat CaseZap continua recebendo e exibindo mensagens entre Lovtok e markus-chatcase.

# Plano: impersonacao segura de superadmin

- [x] Mapear e reutilizar os contratos existentes de JWT, auth e auditoria.
- [x] Implementar `POST /sadmin/impersonation` para usuario e projeto.
- [x] Preservar as claims de impersonacao no `req.authInfo` e no ator de auditoria.
- [x] Cobrir autorizacao, validacoes, claims, expiracao e auditoria com testes focados.
- [x] Executar testes, checks de sintaxe e revisar o diff.

## Revisao

- `node --check` passou nos cinco arquivos JavaScript alterados/adicionados.
- `git diff --check` passou.
- `npx mocha test/sadminImpersonation.test.js test/auditRoute.test.js --exit`: 10 testes passando.

# Auditoria final: impersonacao e WebSocket

- [x] Reservar `token_use=impersonation` e validar origem/shape no Passport.
- [x] Auditar requisicoes impersonadas depois da autenticacao, inclusive GET comum.
- [x] Selecionar owner elegivel de forma deterministica e aplicar allowlist de usuario.
- [x] Encerrar WebSockets existentes no `exp` e bloquear mensagens expiradas.
- [x] Executar testes focados, regressao de auditoria e checks finais.

## Revisao final

- `test/websocketTokenExpiry.test.js`: 4 testes passando.
- `test/sadminImpersonation.test.js` + `test/auditRoute.test.js`: 12 testes passando.
- `node --check` passou nos oito arquivos JavaScript alterados/adicionados.
- `git diff --check` passou.

# Plano: semântica do Status geral

- [x] Cobrir a classificação de canais, core, alertas e snapshot incoerente com testes focais.
- [x] Reusar a mesma regra na geração e na validação do snapshot.
- [x] Rodar suíte operacional completa, sintaxe e revisão do diff.
- [x] Escrever `.superpowers/sdd/status-semantics-report.md` e criar o commit solicitado.

## Revisao: semantica do Status geral

- `npx mocha test/operationalMonitorService.test.js --exit`: 33 testes passando.
- `npx mocha test/operationalAlertNotifier.test.js test/operationalDate.test.js test/operationalMonitorService.test.js test/operationalRoute.js --exit`: 88 testes passando.
- `node --check` passou no servico e no teste focal; `git diff --check` passou.
- O modelo nao mudou; boundedness e redaction existentes foram preservados.
