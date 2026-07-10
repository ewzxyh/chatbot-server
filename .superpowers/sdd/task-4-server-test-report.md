# Task 4: teste temporal do servidor

## Resultado

- O teste `reads only the singleton snapshot for the summary` usa um `Date.now` controlado localmente.
- `generatedAt` e `expiresAt` sao derivados do mesmo `now` controlado, mantendo a assercao `fresh` sem alterar TTL ou producao.
- O clock e restaurado no `finally`, junto com o mock de `OperationalHealthSnapshot.findOne`.

## Verificacoes

- `npx mocha test/operationalMonitorService.test.js --exit` -> `29 passing`.
- `npx mocha test/operationalRoute.js test/operationalDate.test.js test/operationalMonitorService.test.js test/operationalAlertNotifier.test.js test/channelDiagnosticsService.test.js --exit` -> `88 passing`.
- `node --check test/operationalMonitorService.test.js` -> passou.
- `git diff --check` -> passou.

## Escopo

- Teste alterado: `test/operationalMonitorService.test.js`.
- Report: `.superpowers/sdd/task-4-server-test-report.md`.
- Nenhum arquivo de producao foi alterado.

## Avisos

- A suite emitiu apenas warnings legados de Express/Mongoose e listeners do app, sem falhas funcionais.
