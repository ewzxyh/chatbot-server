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

# Plano: compatibilidade de leitura do Status geral

- [x] Cobrir dois snapshots v2 legados e confirmar o RED.
- [x] Manter mismatches nao legados como indisponiveis.
- [x] Confirmar que o monitor persiste `queue down` como `down`.
- [x] Rodar testes focais, suite operacional/rotas, sintaxe e diff.
- [x] Atualizar o relatorio e criar o commit solicitado.

## Revisao: compatibilidade de leitura

- `npx mocha test/operationalMonitorService.test.js --exit`: 36 testes passando.
- Suite operacional completa: 91 testes passando.
- `test/operationalRoute.js`: 47 testes passando.
- O GET normaliza somente a resposta; o snapshot legado lido permanece inalterado.

# Plano: compatibilidade final do Status geral

- [x] Cobrir alertas `down` com core `degraded` e `unknown` em RED.
- [x] Rejeitar `raw=down` e `effective=degraded` sem sinal agregado `down`.
- [x] Confirmar zero escritas Mongo durante a leitura compativel.
- [x] Preservar core `down` e os testes existentes.
- [x] Rodar suite operacional/rotas, sintaxe e diff.
- [x] Atualizar o relatorio e criar o commit solicitado.

## Revisao: compatibilidade final

- `npx mocha test/operationalMonitorService.test.js --exit`: 38 testes passando.
- Suite operacional completa: 93 testes passando.
- O predicado legado usa somente `channels.byStatus.down > 0 || alerts.byStatus.down > 0`.

# Finalizacao: paginacao persistida de diagnosticos de canal

- [x] Revisar o diff contra `c4681bcf` sem reverter o worktree.
- [x] Manter materializacao somente no ciclo writer apos renovacao do lease.
- [x] Manter GET somente-leitura com consultas paginadas, projecao e DTO redacted.
- [x] Corrigir cleanup de ciclos stale e ordenar empates deterministamente.
- [x] Rodar suite operacional, sintaxe e `git diff --check`.
- [x] Escrever `.superpowers/sdd/final-pagination-fix-report.md` e criar o commit solicitado.

## Revisao: finalizacao da paginacao persistida

- Suite solicitada: 101 testes passando.
- `node --check` passou nos cinco arquivos JavaScript alterados/adicionados.
- `git diff --check` passou.

# Correcao: geracoes imutaveis de diagnosticos de canal

- [x] Publicar `activeDiagnosticCycleId` atomico somente apos materializacao completa e fencing do lease.
- [x] Usar chave por ciclo/geracao, batches bounded e cleanup monotonicamente anterior.
- [x] Limitar page/offset e filtrar GET exclusivamente pela geracao publicada, sem probes ou writes.
- [x] Cobrir concorrencia, falha parcial, lease expirado, boundedness, cleanup, filtros e read-only.
- [x] Rodar suite operacional completa, checks finais, atualizar relatorio e criar commit separado.

## Revisao: geracoes imutaveis de diagnosticos

- Suite operacional: 106 testes passando.
- Materializacao bounded, fencing do lease, ponteiro ativo e cleanup monotonicamente anterior cobertos por testes focais.
- `node --check` e `git diff --check` passaram.

# Correcao: leitura atomica da geracao publicada

- [x] Substituir snapshot pointer + count + find por um unico aggregate com `$lookup` e `$facet`.
- [x] Preservar filtros, sort deterministico, paginacao, projecao e contrato vazio.
- [x] Intercalar cleanup no teste e provar count/data consistentes sem queries separadas.
- [x] Corrigir o mock de lease expirado para observar o pointer persistido.
- [x] Rodar suite operacional, checks finais, atualizar relatorio e criar commit separado.

## Revisao: leitura atomica

- Suite operacional: 107 testes passando.
- O GET usa um comando Mongo e continua sem writes, probes ou scans de Integration/kvstore.
- `node --check` e `git diff --check` passaram.

# Correcao: limite de paginacao dos alertas operacionais

- [x] Reusar os tetos de page/offset adotados para canais na listagem de alertas.
- [x] Cobrir page e offset acima do teto no teste de rota.
- [x] Rodar suite operacional completa, `node --check` e revisar o diff.

## Revisao

- Suite operacional completa: 103 testes passando.
- `page=10001` e `page=1002&limit=200` retornam 400 `invalid_operational_filter` sem alterar count, limit ou filtros validos.
- `node --check` e `git diff --check` passaram.

# Correcao: duplicacao de mensagens CaseZap no Chat21

- [x] Confirmar na persistencia se a duplicacao existe antes da renderizacao.
- [x] Correlacionar os pares por `tiledesk_message_id` e identificar os dois writers.
- [x] Auditar a causa raiz com subagente Sol 5.6 max.
- [x] Remover o writer direto e manter o pipeline padrao como fonte unica.
- [x] Rodar testes focais, sintaxe e auditoria do diff.
- [ ] Criar commit, push e aplicar na VPS DEV.
- [ ] Fazer backup e remover apenas os registros historicos redundantes.

## Evidencia inicial

Texto recebido e audio enviado existem uma unica vez em `tiledesk.messages`, mas
duas vezes em `chat21.messages`, com o mesmo `tiledesk_message_id` e IDs Chat21
distintos. O conector grava diretamente e o evento `message.sending` grava de novo
15 a 20 ms depois. Ha 2.066 pares historicos, todos com texto e tipo equivalentes.
