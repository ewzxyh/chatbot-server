# Relatorio final: geracoes imutaveis de diagnosticos de canal

## Escopo

Correcao do fluxo de diagnosticos persistidos a partir do HEAD `7f843f66`, sem reverter alteracoes existentes.

## Solucao

- O lease incrementa `diagnosticGeneration` atomicamente ao ser adquirido.
- Cada diagnostico usa `_id` composto por `cycleId:integrationId`, alem de `cycleId`, `generation` e `cycleAt`; ciclos nunca substituem documentos de outro ciclo.
- A materializacao percorre o array `channels` em slices de 500 e monta somente as operations do batch atual.
- O snapshot singleton publica `activeDiagnosticCycleId` no mesmo update fenced que exige owner e lease ainda valido, somente depois de todos os batches.
- Falha de batch ou lease expirado deixa documentos orfaos sem ponteiro visivel; o ciclo publicado anterior permanece intacto.
- Cleanup acontece depois da publicacao e remove apenas `generation < generationPublicada`, portanto nao remove uma geracao mais nova.
- O GET executa um unico aggregate iniciado no snapshot singleton. O `$lookup` fixa o `activeDiagnosticCycleId` e o `$facet` produz count e data da mesma leitura, com filtros, sort deterministico, skip/limit e projecao allowlisted.
- Cleanup concorrente nao pode mais produzir `count` de uma geracao e `data` depois da remocao. O GET nao usa transaction, `countDocuments`, `find`, Integration/kvstore, probes ou writes. Snapshot sem ponteiro retorna o contrato vazio existente.
- `page` aceita no maximo 10000, `offset` no maximo 200000 e `limit` mantem maximo 200; valores fora do limite retornam 400.
- O model declara somente indices de diagnostico validos para `cycleId` com filtros/ordenacao e para cleanup por `generation`. Nenhum `syncIndexes` foi adicionado ao runtime e o relatorio nao promete migracao automatica de indices legados.

## Testes obrigatorios

Os testes cobrem ciclo antigo tardio sem alterar o ponteiro, falha no segundo batch sem publicacao parcial, leitura exclusiva da geracao publicada, lease expirado durante batches, page/offset acima do teto, batches bounded, cleanup sem apagar geracao nova, cleanup intercalado durante o aggregate e GET sem Integration/kvstore/write/probe/count/find.

## Verificacoes

- Suite operacional: **107 passing**.
- `node --check` nos arquivos JavaScript alterados: passou.
- `git diff --check`: passou.

Os warnings exibidos sao preexistentes da aplicacao, Express/Mongoose e dependencias; nao houve falha funcional.
