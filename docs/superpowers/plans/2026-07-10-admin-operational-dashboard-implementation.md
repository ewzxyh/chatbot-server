# Dashboard Administrativo e Operacional Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox - [ ] syntax for tracking.

**Goal:** Entregar o dashboard operacional superadmin com snapshot v2 duravel, rotas paginadas, agregacao CaseZap/WABA, Operacao filtravel e deploy manual na VPS DEV.

**Architecture:** O monitor Node.js executa probes, grava um singleton bounded em MongoDB e deixa as rotas Express somente-leitura. O dashboard Angular consome os contratos por AdminService, preserva o shell atual e usa deep-links para Operacao.

**Tech Stack:** Node.js CommonJS, Express, Mongoose, Mocha; Angular 14, TypeScript, SCSS, Jasmine; Docker Compose manual na VPS DEV.

## Global Constraints

- Somente operationalMonitorService.js executa probes e grava health._id = "singleton".
- Snapshot v2 guarda somente services, queues, agregados channels e alerts; cada topCauses tem no maximo 5 itens.
- Statuses validos: ok, degraded, down, unknown; severidade: down, degraded, unknown, ok.
- GET /sadmin/health/summary nunca executa probe ou escreve MongoDB; deriva fresh, stale ou missing.
- Sem snapshot: 200, snapshotState: "missing", overallStatus: "unknown", listas vazias e agregados zerados.
- Documento invalido ou falha de leitura: 503 com { "error": { "code": "health_snapshot_unavailable", "message": "Operational health snapshot unavailable" } }.
- Canais leem Integration.value.operational e kvstore.value.operational; alertas leem OperationalAlert.
- Paginacao exata: { data, count, page, limit }; count e calculado antes da pagina.
- POST /sadmin/health/channels/test continua sendo a unica acao explicita por integracao; nao criar rota geral de probes.
- Reutilizar autenticacao superadmin, redaction, shell visual, loading/error/empty e acessibilidade existentes.
- Nao criar dependencia nem diretorio novo; nao alterar outro projeto fora dos dois caminhos indicados.

---

### Task 1: Snapshot e monitor

Files:
- Create: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-server\models\operationalHealthSnapshot.js
- Modify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-server\services\operationalHealthService.js
- Modify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-server\services\operationalMonitorService.js
- Test: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-server\test\operationalMonitorService.test.js

Interfaces:
- Model Mongoose OperationalHealthSnapshot: collection health, _id string, version 2, timestamps, services, queues, channels e alerts.
- operationalHealthService.buildSnapshot(input, now) -> snapshotV2 agrega severidade/status/produto e limita causas a 5.
- operationalHealthService.deriveSnapshotState(snapshot, now) -> fresh | stale | missing; nao escreve.
- operationalMonitorService.runOnce() -> Promise<snapshotV2>; atualiza somente _id: "singleton".
- operationalMonitorService.testIntegration(integrationId) -> Promise<monitorResult>; executa somente uma integracao.

- [ ] Step 1: Escrever testes Mocha que falham para statuses, severidade, singleton, bounded snapshot, cinco causas e fresh/stale/missing.

    it('keeps the snapshot bounded', async () => {
      const snapshot = operationalHealthService.buildSnapshot(inputWithSixCauses(), now);
      assert.strictEqual(snapshot.version, 2);
      assert.strictEqual(snapshot.channels.topCauses.length, 5);
      assert.strictEqual(snapshot.alerts.topCauses.length, 5);
    });

- [ ] Step 2: Confirmar a falha.

    cd C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-server
    npx mocha test/operationalMonitorService.test.js

  Expected: FAIL no contrato v2 ou no limite bounded.

- [ ] Step 3: Implementar o model, agregadores, derivacao de estado e upsert singleton no monitor, sem persistir registros individuais.
- [ ] Step 4: Cobrir o monitor real e garantir que o teste forcado nao execute a rodada completa.
- [ ] Step 5: Verificar e commitar.

    npx mocha test/operationalMonitorService.test.js
    git add models/operationalHealthSnapshot.js services/operationalHealthService.js services/operationalMonitorService.js test/operationalMonitorService.test.js
    git commit -m "feat: add bounded operational health snapshot monitor"

  Expected: testes PASS e um commit somente no servidor.

### Task 2: Rotas paginadas

Files:
- Modify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-server\services\operationalHealthService.js
- Modify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-server\services\operationalAlertService.js
- Modify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-server\services\operationalMonitorService.js
- Modify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-server\routes\sadmin.js
- Test: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-server\test\operationalRoute.js

Interfaces:
- operationalHealthService.getSummary() -> Promise<SummaryV2>; le somente o singleton.
- operationalHealthService.listChannels(filters) -> Promise<{ data, count, page, limit }>; le Integration/kvstore operacionais.
- operationalAlertService.list(filters) -> Promise<{ data, count, page, limit }>; le OperationalAlert.
- GET /sadmin/health/summary, /sadmin/health/channels e /sadmin/operational-alerts aceitam page, limit, product, channel, status, cause e datas aplicaveis.
- POST /sadmin/health/channels/test exige { integrationId } e chama testIntegration(integrationId).

- [ ] Step 1: Escrever teste de rota que falha para shape exato, count total, filtros, vazio 200, 503, auth, redaction e separacao GET/POST.

    it('returns the exact paginated shape', async () => {
      const response = await request(app)
        .get('/sadmin/health/channels?page=2&limit=25&status=degraded')
        .set(superadminHeaders);
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(Object.keys(response.body), ['data', 'count', 'page', 'limit']);
    });

- [ ] Step 2: Confirmar a falha.

    cd C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-server
    npx mocha test/operationalRoute.js

  Expected: FAIL nas rotas ou no contrato paginado.

- [ ] Step 3: Implementar os handlers em routes/sadmin.js, reutilizando auth/redaction e validacao server-side de page, limit e filtros.
- [ ] Step 4: Implementar consultas com count antes do slice, mapeamento de id/produto/canal/status/causa/timestamps e erro equivalente existente.
- [ ] Step 5: Verificar POST, suite e commit.

    npx mocha test/operationalRoute.js test/operationalMonitorService.test.js
    git add services/operationalHealthService.js services/operationalAlertService.js services/operationalMonitorService.js routes/sadmin.js test/operationalRoute.js
    git commit -m "feat: add paginated operational admin routes"

  Expected: GETs nao executam probes; POST exige uma integracao; suite PASS.

### Task 3: Dashboard agregado

Files:
- Modify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard\src\app\services\admin.service.ts
- Modify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard\src\app\admin-panel\admin-dashboard\admin-dashboard.component.ts
- Modify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard\src\app\admin-panel\admin-dashboard\admin-dashboard.component.html
- Test: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard\src\app\admin-panel\admin-dashboard\admin-dashboard.component.spec.ts

Interfaces:
- AdminService.getOperationalHealthSummary(): Observable<HealthSummaryV2>; chama somente o summary.
- AdminService.getOperationalChannels(filters): Observable<PagedResponse<ChannelDiagnostic>>.
- AdminService.getOperationalAlerts(filters): Observable<PagedResponse<OperationalAlert>>.
- AdminDashboardComponent expoe summary, loading, error, retry() e buildOperationLink(filters).

- [ ] Step 1: Escrever specs Jasmine que falham para CaseZap/WABA por status/causa, fresh/stale/missing, loading, retry e deep-link com product/channel/status/cause.

    it('keeps all four filters in the Operation link', () => {
      expect(component.buildOperationLink({
        product: 'waba',
        channel: 'webhook',
        status: 'degraded',
        cause: 'upstream_timeout'
      })).toContain('product=waba&channel=webhook&status=degraded&cause=upstream_timeout');
    });

- [ ] Step 2: Confirmar a falha.

    cd C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard
    npx ng test --watch=false --browsers=ChromeHeadless --include=src/app/admin-panel/admin-dashboard/admin-dashboard.component.spec.ts

  Expected: FAIL enquanto cliente e estados nao estiverem conectados.

- [ ] Step 3: Implementar AdminService e componente com agregados por produto/status, top causes, services/queues, erro com retry e empty contextual; sem probe no browser.
- [ ] Step 4: Compilar, testar e commitar.

    npx ngc -p src/tsconfig.app.json
    npx ng test --watch=false --browsers=ChromeHeadless --include=src/app/admin-panel/admin-dashboard/admin-dashboard.component.spec.ts
    git add src/app/services/admin.service.ts src/app/admin-panel/admin-dashboard/admin-dashboard.component.ts src/app/admin-panel/admin-dashboard/admin-dashboard.component.html src/app/admin-panel/admin-dashboard/admin-dashboard.component.spec.ts
    git commit -m "feat: add aggregated operational dashboard"

  Expected: ngc e Jasmine PASS.

### Task 4: Operacao paginada

Files:
- Modify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard\src\app\services\admin.service.ts
- Modify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard\src\app\admin-panel\admin-operation\admin-operation.component.ts
- Modify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard\src\app\admin-panel\admin-operation\admin-operation.component.html
- Modify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard\src\app\admin-panel\admin-operation\admin-operation.component.scss
- Create: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard\src\app\admin-panel\admin-operation\admin-operation.component.spec.ts

Interfaces:
- AdminOperationComponent.filters: { page, limit, product?, channel?, status?, cause?, from?, to? }.
- AdminOperationComponent.load(), retry(), changePage(page) e clearFilters().
- AdminService retorna { data, count, page, limit } para canais e alertas.

- [ ] Step 1: Escrever spec Jasmine que falha para query filters, count, paginacao e estados loading/error/empty.

    it('keeps filters when changing page', () => {
      component.filters = { page: 1, limit: 25, product: 'casezap', status: 'down' };
      component.changePage(2);
      expect(adminService.getOperationalChannels).toHaveBeenCalledWith(
        jasmine.objectContaining({ page: 2, product: 'casezap', status: 'down' })
      );
    });

- [ ] Step 2: Confirmar a falha.

    npx ng test --watch=false --browsers=ChromeHeadless --include=src/app/admin-panel/admin-operation/admin-operation.component.spec.ts

  Expected: FAIL enquanto a tela nao usar os endpoints paginados.

- [ ] Step 3: Implementar Operacao com filtros server-side, tabelas de canais/alertas, page/limit/count, retry, empty diferente de snapshot ausente e preservacao do deep-link.
- [ ] Step 4: Rodar build e commit.

    npx ngc -p src/tsconfig.app.json
    npx ng test --watch=false --browsers=ChromeHeadless --include=src/app/admin-panel/admin-operation/admin-operation.component.spec.ts
    npx ng build --configuration production
    git add src/app/services/admin.service.ts src/app/admin-panel/admin-operation
    git commit -m "feat: add paginated operational view"

  Expected: compilacao, spec e build PASS.

### Task 5: Outras tabs e shell

Files:
- Modify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard\src\app\admin-panel\admin-panel.component.ts
- Modify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard\src\app\admin-panel\admin-panel.component.html
- Modify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard\src\app\admin-panel\admin-panel.component.scss
- Modify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard\src\app\admin-panel\admin-projects\admin-projects.component.ts
- Modify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard\src\app\admin-panel\admin-projects\admin-projects.component.html
- Modify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard\src\app\admin-panel\admin-users\admin-users.component.ts
- Modify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard\src\app\admin-panel\admin-users\admin-users.component.html
- Modify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard\src\app\admin-panel\admin-payments\admin-payments.component.ts
- Modify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard\src\app\admin-panel\admin-payments\admin-payments.component.html
- Modify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard\src\app\admin-panel\admin-audit\admin-audit.component.ts
- Modify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard\src\app\admin-panel\admin-audit\admin-audit.component.html
- Modify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard\src\app\admin-panel\admin-audit\admin-audit.component.scss
- Modify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard\src\app\admin-panel\admin-privacy\admin-privacy.component.ts
- Modify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard\src\app\admin-panel\admin-privacy\admin-privacy.component.html
- Modify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard\src\app\admin-panel\admin-privacy\admin-privacy.component.scss
- Create: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard\src\app\admin-panel\admin-panel.component.spec.ts

Interfaces:
- AdminPanelComponent.activeTab: dashboard | projects | users | payments | operation | audit | privacy.
- Navegacao existente acessivel por teclado com sete links: Dashboard, Projetos, Usuarios, Pagamentos, Operacao, Auditoria e Privacidade; estado ativo, foco visivel, responsividade e estados loading/error/empty compartilhados.
- Dashboard permanece como referencia; as seis outras paginas preservam seus componentes e conteudo funcional.

- [ ] Step 1: Escrever spec Jasmine que falha para sete links, incluindo Dashboard, link ativo, teclado, retorno ao dashboard e estados das seis outras paginas.
- [ ] Step 2: Confirmar a falha.

    cd C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard
    npx ng test --watch=false --browsers=ChromeHeadless --include=src/app/admin-panel/admin-panel.component.spec.ts

  Expected: FAIL enquanto shell e estados nao estiverem cobertos.

- [ ] Step 3: Implementar o shell em admin-panel.component.*, mantendo Dashboard, Projetos, Usuarios, Pagamentos, Operacao, Auditoria e Privacidade; nao remover nem fundir Dashboard; aplicar a melhoria de estados e responsividade as seis outras paginas.
- [ ] Step 4: Rodar suite, build e commit.

    npx ngc -p src/tsconfig.app.json
    npx ng test --watch=false --browsers=ChromeHeadless
    npm run build
    git add src/app/admin-panel
    git commit -m "feat: preserve admin tab shell and states"

  Expected: TypeScript, Jasmine e build Angular PASS.

### Task 6: Integracao Docker/VPS DEV

Files:
- Verify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-server\test\operationalMonitorService.test.js
- Verify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-server\test\operationalRoute.js
- Verify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard\src\app\admin-panel\admin-dashboard\admin-dashboard.component.spec.ts
- Verify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard\src\app\admin-panel\admin-operation\admin-operation.component.spec.ts
- Verify: C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard\src\app\admin-panel\admin-panel.component.spec.ts

Interfaces:
- operationalMonitorService.runOnce() deve criar o singleton v2 antes de ativar a UI.
- Rotas publicadas devem manter summary, detalhes paginados e POST forcado.
- Deploy manual: git pull, docker compose build, docker compose up -d, verificacao de containers e logs na VPS DEV.

- [ ] Step 1: Rodar verificacao local completa.

    cd C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-server
    npx mocha test/operationalMonitorService.test.js test/operationalRoute.js
    cd C:\Users\enzo\chatcase-tiledesk\chatcase-tiledesk-dashboard
    npx ngc -p src/tsconfig.app.json
    npx ng test --watch=false --browsers=ChromeHeadless
    npm run build

  Expected: Mocha, Jasmine, ngc e build PASS.

- [ ] Step 2: Criar snapshot no servidor DEV.

    node -e "const monitor = require('./services/operationalMonitorService'); monitor.runOnce().then((snapshot) => { if (!snapshot || snapshot.version !== 2) throw new Error('invalid operational snapshot'); process.exit(0); }).catch((error) => { console.error(error); process.exit(1); });"

  Expected: singleton v2 valido, bounded e com top causes limitadas.

- [ ] Step 3: Publicar manualmente na VPS DEV.

    git pull --ff-only
    docker compose build
    docker compose up -d
    docker compose ps
    docker compose logs --tail=200

  Expected: containers ativos e sem erro de boot ou MongoDB.

- [ ] Step 4: Smoke-testar com superadmin.

    curl -fsS -H "Authorization: Bearer $SADMIN_TOKEN" "$DEV_BASE_URL/sadmin/health/summary"
    curl -fsS -H "Authorization: Bearer $SADMIN_TOKEN" "$DEV_BASE_URL/sadmin/health/channels?page=1&limit=25"
    curl -fsS -H "Authorization: Bearer $SADMIN_TOKEN" "$DEV_BASE_URL/sadmin/operational-alerts?page=1&limit=25"

  Expected: summary 200 com fresh/stale, detalhes com { data, count, page, limit }, sem probe em GET e sem segredo exposto.

- [ ] Step 5: Validar UI DEV: agregacao CaseZap/WABA, deep-link com quatro filtros, paginacao, loading, erro/retry, empty filtrado e navegacao responsiva.
- [ ] Step 6: Liberar somente depois de snapshot valido e testes de auth, redaction, contrato e UI; acompanhar idade do snapshot, falhas do monitor, 503 e erros do dashboard.

## Criterio Final

- [ ] Snapshot v2 singleton bounded atualizado somente pelo monitor.
- [ ] Summary e detalhes usam as fontes persistidas corretas e os contratos exatos.
- [ ] POST forcado exige integracao e nao existe rota geral de probes.
- [ ] Dashboard e Operacao preservam agregacao, filtros, estados e deep-links.
- [ ] A navegacao preserva sete links: Dashboard, Projetos, Usuarios, Pagamentos, Operacao, Auditoria e Privacidade; as seis outras paginas preservam shell, acessibilidade e responsividade.
- [ ] Mocha, Jasmine, ngc, npm run build e Docker Compose na VPS DEV passam antes da ativacao.
