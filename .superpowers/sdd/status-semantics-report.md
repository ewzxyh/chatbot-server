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

## Compatibilidade de leitura

Snapshots v2 legados com `overallStatus=down` sao aceitos somente quando a semantica efetiva nova e `degraded` por um destes motivos:

- `channels.byStatus.down > 0`; ou
- `alerts.byStatus.down > 0`.

O estado do core nao restringe essa compatibilidade: alertas `down` com core `degraded` ou `unknown` tambem normalizam a resposta para `degraded`. Core realmente `down` continua produzindo status efetivo `down`, portanto nao entra na normalizacao.

O `GET /sadmin/health/summary` normaliza apenas o DTO retornado. O documento lido nao e alterado e nenhuma escrita no MongoDB e executada; o proximo ciclo do monitor persiste naturalmente a semantica nova.

Outros mismatches continuam retornando `health_snapshot_unavailable`, incluindo raw `down` com efetivo `degraded` sem qualquer sinal agregado `down`, `down` com tudo `ok`, `ok` com core `down` e `degraded` quando o efetivo e `down`.

## Testes

- Testes focais: 38 passando.
- Suite operacional completa (notifier, datas, monitor e rota): 93 passando.
- Suite de rotas operacionais isolada: 47 passando.
- `node --check services/operationalHealthService.js`: passou.
- `node --check test/operationalMonitorService.test.js`: passou.
- `git diff --check`: passou.

## Preocupacoes

Os testes ainda emitem avisos preexistentes de `express-session`, driver MongoDB, dependencia circular e `MaxListenersExceededWarning`. Eles nao foram introduzidos nem tratados nesta mudanca.
