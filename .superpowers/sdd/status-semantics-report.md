# Relatorio: semantica do Status geral

## Escopo

Correcao cirurgica no servidor ChatCase para evitar que a queda parcial de canais classifique a plataforma inteira como indisponivel.

## Regra aplicada

- `down`: qualquer servico ou fila central em `down`, ou todos os canais monitorados em `down`.
- `degraded`: falha parcial de canais, componente `degraded`, ou alerta ativo relevante/critico sem queda central.
- `ok`: componentes monitorados saudaveis e sem alerta relevante.
- `unknown`: estado desconhecido de algum componente; snapshot ausente continua sendo exposto como `unknown` pelo contrato existente.

Alertas normalizados como `down` por severidade critica nao promovem o Status geral para `down` sozinhos.

## Implementacao

`services/operationalHealthService.js` agora usa `classifyOverallStatus` tanto em `buildSnapshot` quanto em `effectiveSnapshotStatus`, que sustenta a validacao do snapshot persistido. O modelo nao precisou de alteracao.

O caminho de status interno do RabbitMQ foi mantido separado: filas com backlog continuam sendo `degraded` no servico, enquanto uma fila central efetivamente `down` promove o snapshot geral para `down`.

Boundedness, allowlist de causas e redaction permanecem inalterados.

## Testes

- Testes focais: 33 passando.
- Suite operacional completa (notifier, datas, monitor e rota): 88 passando.
- `node --check services/operationalHealthService.js`: passou.
- `node --check test/operationalMonitorService.test.js`: passou.
- `git diff --check`: passou.

## Preocupacoes

Os testes ainda emitem avisos preexistentes de `express-session`, driver MongoDB, dependencia circular e `MaxListenersExceededWarning`. Eles nao foram introduzidos nem tratados nesta mudanca.
