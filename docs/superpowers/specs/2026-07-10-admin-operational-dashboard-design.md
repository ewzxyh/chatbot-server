# Dashboard Administrativo e Operacional

## Objetivo

Um unico monitor executa probes externos e grava um snapshot duravel singleton no MongoDB. As leituras do dashboard nao executam probes nem escrevem estado. CaseZap e WABA aparecem agregados por status e causa, com acesso aos detalhes em Operacao.

## Arquitetura e persistencia

- O monitor e o unico executor de probes externos. Cada execucao registra o resultado dos servicos e filas monitorados e atualiza o documento `_id: "singleton"` da colecao de health.
- O snapshot v2 e bounded: guarda somente `services`, `queues`, agregados de `channels` e `alerts`, mais as top causas limitadas a 5 itens por agregado. Nao guarda registros individuais de integracoes, canais ou alertas.
- `GET /sadmin/health/summary` e somente leitura e deriva `snapshotState` de `generatedAt`/`expiresAt` sem atualizar o snapshot.
- `GET /sadmin/health/channels` le diagnosticos ja persistidos em `Integration.value.operational` ou `kvstore.value.operational`; nao le uma lista de canais do snapshot.
- `GET /sadmin/operational-alerts` le registros persistidos em `OperationalAlert`; nao le uma lista de alertas do snapshot.
- O teste forçado por uma unica integracao permanece explicito em `POST /sadmin/health/channels/test`. Nenhum GET dispara teste; o POST solicita ao monitor a execucao para a integracao indicada.

## Contrato do snapshot e do summary v2

O documento persistido e a resposta de `GET /sadmin/health/summary` usam esta forma bounded. `snapshotState` e `fresh`, `stale` ou `missing`; quando ha documento, o estado e derivado sem escrita.

```json
{
  "version": 2,
  "overallStatus": "degraded",
  "snapshotState": "fresh",
  "generatedAt": "2026-07-10T12:00:00.000Z",
  "expiresAt": "2026-07-10T12:05:00.000Z",
  "services": [
    { "name": "server", "status": "ok", "cause": null, "checkedAt": "2026-07-10T11:59:58.000Z" },
    { "name": "mongo", "status": "ok", "cause": null, "checkedAt": "2026-07-10T11:59:58.000Z" },
    { "name": "redis", "status": "ok", "cause": null, "checkedAt": "2026-07-10T11:59:58.000Z" },
    { "name": "rabbitmq", "status": "ok", "cause": null, "checkedAt": "2026-07-10T11:59:58.000Z" },
    { "name": "storage", "status": "degraded", "cause": "upstream_timeout", "checkedAt": "2026-07-10T11:59:55.000Z" }
  ],
  "queues": [
    { "name": "jobsmanager", "status": "ok", "cause": null, "checkedAt": "2026-07-10T11:59:57.000Z" },
    { "name": "webhooks", "status": "ok", "cause": null, "checkedAt": "2026-07-10T11:59:57.000Z" },
    { "name": "messages", "status": "ok", "cause": null, "checkedAt": "2026-07-10T11:59:57.000Z" },
    { "name": "logs_queue", "status": "ok", "cause": null, "checkedAt": "2026-07-10T11:59:57.000Z" },
    { "name": "conversation-tags_queue", "status": "ok", "cause": null, "checkedAt": "2026-07-10T11:59:57.000Z" },
    { "name": "persist", "status": "ok", "cause": null, "checkedAt": "2026-07-10T11:59:57.000Z" }
  ],
  "channels": {
    "count": 12,
    "byStatus": { "ok": 9, "degraded": 2, "down": 1, "unknown": 0 },
    "byProduct": {
      "casezap": { "ok": 5, "degraded": 1, "down": 0, "unknown": 0 },
      "waba": { "ok": 4, "degraded": 1, "down": 1, "unknown": 0 }
    },
    "topCauses": [{ "cause": "upstream_timeout", "count": 2 }]
  },
  "alerts": {
    "count": 3,
    "byStatus": { "ok": 0, "degraded": 2, "down": 1, "unknown": 0 },
    "topCauses": [{ "cause": "upstream_timeout", "count": 2 }]
  }
}
```

Os unicos statuses validos sao `ok`, `degraded`, `down` e `unknown`. O `overallStatus` usa a maior severidade observada: `down`, depois `degraded`, depois `unknown`, e `ok` quando nao ha estado pior. `cause` e um codigo estavel ou `null`. O monitor limita o tamanho de `services` e `queues` ao conjunto de componentes configurado e cada `topCauses` a no maximo 5 itens.

## Endpoints de detalhe

Ambos aceitam `page` (1-based), `limit`, `product`, `channel`, `status`, `cause` e os filtros de data existentes quando aplicaveis. `limit` e validado pelo servidor. A resposta paginada usa exatamente o formato padrao:

```json
{
  "data": [
    {
      "id": "integration-01",
      "product": "waba",
      "channel": "webhook",
      "status": "degraded",
      "cause": "upstream_timeout",
      "checkedAt": "2026-07-10T11:59:55.000Z"
    }
  ],
  "count": 1,
  "page": 1,
  "limit": 25
}
```

- `GET /sadmin/health/channels`: pagina diagnosticos encontrados em `Integration.value.operational` e `kvstore.value.operational`. O mapeamento deve preservar a identificacao da integracao, produto, canal, status, causa e data persistidos.
- `GET /sadmin/operational-alerts`: pagina `OperationalAlert` com os mesmos filtros quando disponiveis, preservando seu identificador e timestamps.
- Resultado sem correspondencias e `200` com `data: []`, `count: 0`, `page` e `limit` recebidos/normalizados.
- `count` e o total de registros que atendem aos filtros, antes de aplicar `page` e `limit`; nao e o tamanho da pagina em `data`.

## Teste forcado

`POST /sadmin/health/channels/test` continua sendo a unica acao explicita para testar uma integracao. Deve preservar o request e a resposta existentes, aceitar apenas a integracao indicada e encaminhar a execucao ao monitor. A acao nao altera o contrato dos GETs e nao cria um endpoint alternativo.

## Fallback, seguranca e UI

- Sem snapshot, o summary retorna `200` com `snapshotState: "missing"`, `overallStatus: "unknown"`, `services: []`, `queues: []` e agregados zerados. Os endpoints de detalhe continuam consultando suas fontes persistidas e podem retornar dados mesmo sem snapshot.
- Snapshot expirado retorna os dados persistidos com `snapshotState: "stale"`; nao e apresentado como atual nem regravado por leitura.
- Falha de leitura ou documento invalido retorna `503` com `{ "error": { "code": "health_snapshot_unavailable", "message": "Operational health snapshot unavailable" } }` no summary, e o erro equivalente ja usado pelas rotas de detalhe.
- As rotas usam a autenticacao superadmin existente. Aplicam a redaction existente a tokens, credenciais, headers e payloads; nao criam novos scopes, CSRF ou feature flags.
- Filtros, `page` e `limit` sao validados no servidor e as respostas nao expoem segredos.
- O dashboard reutiliza o shell visual existente nas tabs `Projetos`, `Usuarios`, `Pagamentos`, `Operacao`, `Auditoria` e `Privacidade`, sem cards aninhados.
- O dashboard mostra CaseZap/WABA por status e causa e cria deep-link para `Operacao` com `product`, `channel`, `status` e `cause` preservados.
- `Operacao` detalha canais e alertas com filtros e paginacao. Loading usa o padrao existente; erro permite retry sem dados inventados; empty diferencia filtro sem resultado de snapshot ausente. A navegacao das tabs permanece acessivel e responsiva.

## Testes

- Unitarios: statuses validos, severidade de `overallStatus`, agregacao bounded, limite de 5 top causas e estados `fresh`/`stale`/`missing`.
- Integracao: o singleton contem apenas servicos, filas e agregados; summary nao executa probe nem escreve Mongo; detalhes leem `Integration.value.operational`, `kvstore.value.operational` e `OperationalAlert`; GETs nao usam registros do snapshot como detalhe.
- API: contrato v2, resposta paginada exata `{data,count,page,limit}`, filtros, limites, `200/503`, redaction e autenticacao superadmin.
- Teste forcado: `POST /sadmin/health/channels/test` exige uma integracao, encaminha uma unica execucao ao monitor e nenhum GET o substitui.
- E2E: agregacao CaseZap/WABA, deep-link com filtros, paginacao, loading/error/empty e navegacao responsiva nas seis tabs.

## Rollout

1. Publicar o modelo singleton v2, o monitor e as leituras sem ativar o frontend.
2. Executar o monitor uma vez para criar o snapshot singleton e verificar `overallStatus`, servicos, filas, agregados e top causas limitadas.
3. Validar as rotas paginadas contra `Integration.value.operational`, `kvstore.value.operational` e `OperationalAlert`, incluindo snapshot ausente e stale.
4. Ativar o frontend somente depois de existir um snapshot valido e dos testes de autorizacao, redaction e contrato passarem.
5. Acompanhar idade do snapshot, falhas do monitor, respostas `503` e erros da UI; manter o ultimo snapshot sem apagar dados persistidos de diagnostico.

## Criterios de aceite

- Existe um unico snapshot v2 duravel, bounded e atualizado pelo monitor; ele nao duplica registros individuais de canais ou alertas.
- `GET /sadmin/health/summary` retorna `overallStatus`, `snapshotState`, `services`, `queues`, `channels` agregado e `alerts` agregado com top causas de no maximo 5.
- `GET /sadmin/health/channels` e `GET /sadmin/operational-alerts` sao paginados, filtraveis e leem as fontes persistidas de diagnostico com `{data,count,page,limit}`.
- `POST /sadmin/health/channels/test` continua sendo o teste forcado explicito por integracao; nao existe `/sadmin/health/probes/run`.
- Nenhum GET executa probe ou escreve estado; snapshot ausente/stale e exibido corretamente.
- O dashboard agrega CaseZap/WABA, faz deep-link para Operacao e as seis tabs reutilizam o shell visual existente, sem cards aninhados e com comportamento responsivo.
- Testes, redaction e autenticacao superadmin passam antes da ativacao do frontend, apos a execucao inicial do monitor.
