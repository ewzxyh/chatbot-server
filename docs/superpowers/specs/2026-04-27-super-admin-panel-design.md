# Super-Admin Panel — ChatCase SaaS

## Objetivo

Painel administrativo acessível apenas ao super-admin (ADMIN_EMAIL) para visualizar e gerenciar todos os projetos, usuários, assinaturas e uso da plataforma. Inclui gerenciamento de planos, extensão de trial, override de quotas e histórico de pagamentos.

## Detecção de Super-Admin

### Server
- Endpoints admin protegidos por middleware chain: `[passport.authenticate(['basic', 'jwt'], { session: false }), validtoken, superAdminCheck]`
- `superAdminCheck` verifica `req.user.email === process.env.ADMIN_EMAIL`
- Middleware extraído como função reutilizável em `middleware/super-admin-check.js`
- Montado em `/sadmin` (evita conflito com `/admin` legado comentado em app.js:538)
- **IMPORTANTE:** Rota `/sadmin` montada em app.js ANTES da linha 585 (middleware `/:projectid/`) para evitar que Express interprete "sadmin" como projectId

### Dashboard
- No login, o server retorna `role: "admin"` no body HTTP (auth.js:658-661) — NÃO está no JWT
- **IMPORTANTE:** `AuthService.signin()` (auth.service.ts:695-717) atualmente ignora `jsonRes['role']`. Modificar para salvar: `localStorage.setItem('superadmin_role', jsonRes['role'] || '')`
- Nova propriedade `isSuperAdmin: boolean` em `AuthService`, computada como `localStorage.getItem('superadmin_role') === 'admin'`
- `SuperAdminGuard` (novo arquivo, NÃO confundir com `AdminGuard` existente que é project-scoped) verifica `authService.isSuperAdmin` para proteger rotas `/admin`

## Arquitetura

### Backend — Novos endpoints (montados em `/sadmin`)

| Endpoint | Método | Descrição |
|---|---|---|
| `GET /sadmin/stats` | GET | Métricas globais (total projetos, usuários, receita, distribuição por plano) |
| `GET /sadmin/projects` | GET | Lista todos os projetos (paginado: page, limit, sortField, direction) |
| `GET /sadmin/users` | GET | Lista todos os usuários (paginado) |
| `GET /sadmin/payments` | GET | Lista todos os SubscriptionPayment (paginado) |
| `PUT /sadmin/projects/:id/plan` | PUT | Trocar plano de um projeto |
| `PUT /sadmin/projects/:id/trial` | PUT | Estender trial (define trialDays) |
| `PUT /sadmin/projects/:id/quotas` | PUT | Override de quotas (contacts, platforms, agents, chatbots, kbs) |

Todos protegidos por `superAdminCheck` middleware.

### Paginação
Segue padrão existente do codebase (`answered.js`):
- Query params: `page` (default 0), `limit` (default 20), `sortField` (default 'createdAt'), `direction` (default -1)
- Response: `{ data: [...], count: totalCount, page, limit }`

### Novo arquivo de rotas
`routes/sadmin.js` — arquivo único com todos os endpoints admin. Registrado em `app.js` com `app.use('/sadmin', sadmin)`.

### Middleware superAdminCheck
```javascript
function superAdminCheck(req, res, next) {
  if (!req.user || req.user.email !== process.env.ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Super-admin access required' });
  }
  next();
}
```

## Frontend

### Módulo
`src/app/admin-panel/` — lazy-loaded module com sub-componentes

### Routing
```
/admin → AdminDashboardComponent (redirect default)
/admin/projects → AdminProjectsComponent
/admin/users → AdminUsersComponent  
/admin/payments → AdminPaymentsComponent
```

Rota em `app.routing.ts`:
```typescript
{
  path: 'admin',
  loadChildren: () => import('app/admin-panel/admin-panel.module').then(m => m.AdminPanelModule),
  canActivate: [AuthGuard, SuperAdminGuard],
}
```

### Guard
`SuperAdminGuard` em `src/app/core/super-admin.guard.ts`:
- Injeta `AuthService`
- Verifica `authService.isSuperAdmin`
- Se false, redireciona para `/projects`

### Sidebar
- Ícone `admin_panel_settings` com texto "Admin"
- Posição: abaixo dos items existentes, antes do settings
- `*ngIf="isSuperAdmin"` — variável populada via `AuthService.isSuperAdmin`
- Click navega para `/admin` (rota absoluta, não scoped a projeto)

### Navegação interna
O módulo admin tem sua própria **nav horizontal** (tabs/pills) no topo:
`Dashboard | Projetos | Usuários | Pagamentos`
Mesmo padrão visual do Settings que tem nav interna.

### Serviço
`src/app/services/admin.service.ts` — HTTP client para `/sadmin/*`
- `getStats(): Observable<Stats>`
- `getProjects(page, limit, sortField, direction, filters): Observable<PaginatedResponse>`
- `getUsers(page, limit, search): Observable<PaginatedResponse>`
- `getPayments(page, limit, filters): Observable<PaginatedResponse>`
- `updateProjectPlan(projectId, planKey): Observable<any>`
- `extendTrial(projectId, trialDays): Observable<any>`
- `updateQuotas(projectId, quotas): Observable<any>`

Segue padrão de HttpHeaders manual (mesmo que CasepayService).

## Páginas

### 1. Dashboard Admin (`/admin`)

Cards com métricas:
- Total de projetos
- Total de usuários
- Receita mensal estimada (soma dos monthlyPrice de projetos com type='payment')
- Distribuição por plano: contadores Free / Standard / Pro / Enterprise / Custom

Dados vêm de `GET /sadmin/stats`.

### 2. Projetos (`/admin/projects`)

Tabela paginada com colunas:
| Coluna | Fonte |
|---|---|
| Nome | project.name |
| Owner | project_user com role='owner' → user.email |
| Plano (displayName) | profile.name → mapeado para displayName |
| Tipo | profile.type (free/payment) |
| Contatos | uso/limite (Lead.countDocuments + profile.quotes.contacts) |
| Plataformas | uso/limite (Integration.countDocuments + profile.quotes.platforms) |
| Membros | uso/limite (Project_user.countDocuments + profile.agents) |
| Trial expira em | trialDaysLeft (virtual field) |
| MandateId | profile.mandateId (se ativo) |
| Criado em | createdAt |

Filtros: dropdown por plano, dropdown por tipo (free/payment)

**Aggregate pipeline para owner email:** O endpoint `GET /sadmin/projects` usa `Project.aggregate()` com `$lookup` de `project_users` (filtro `role: 'owner'`) e depois `$lookup` de `users` para obter o email do owner. Retorna `ownerEmail` junto com os dados do projeto.

Ações por linha (botões):
- **Editar plano:** Modal com select de plano (Free/Starter/Pro/Business). Chama `PUT /sadmin/projects/:id/plan`
- **Estender trial:** Modal com input de dias. Chama `PUT /sadmin/projects/:id/trial`
- **Override quotas:** Modal com inputs para contacts, platforms, agents, chatbots, kbs. Chama `PUT /sadmin/projects/:id/quotas`

### 3. Usuários (`/admin/users`)

Tabela paginada com colunas:
| Coluna | Fonte |
|---|---|
| Nome | firstname + lastname |
| Email | email |
| Verificado | emailverified (ícone check/cross) |
| Projetos | count de project_users com id_user |
| Criado em | createdAt |

Busca: campo de texto que filtra por email ou nome (server-side via regex).

### 4. Pagamentos (`/admin/payments`)

Tabela paginada com colunas:
| Coluna | Fonte |
|---|---|
| Projeto | project_id → project.name (populate) |
| Plano | plan_name |
| Valor | amount (R$) |
| Tipo evento | event_type |
| Status | status |
| MandateId | mandate_id |
| Data | createdAt |

Filtros: dropdown por status, busca por project name.

## Endpoints — Detalhes

### GET /sadmin/stats

```javascript
{
  totalProjects: Number,
  totalUsers: Number,
  monthlyRevenue: Number,
  planDistribution: {
    free: Number,
    starter: Number, 
    pro: Number,
    business: Number,
    custom: Number,
    other: Number
  }
}
```

Queries:
- `Project.countDocuments()` para total projetos
- `User.countDocuments({ status: 100 })` para total usuários
- `Project.aggregate` agrupando por `profile.name` para distribuição
- Receita: para cada projeto com `profile.type: 'payment'`, calcula contribuição mensal: se `billingPeriod === 'annual'` usa `annualPrice / 12`, senão usa `monthlyPrice`. Soma total = receita mensal estimada
- **Legacy plans:** Mapear nomes legados para os novos: Sandbox→free, Basic→starter, Premium→pro, Team→business. Planos não mapeados contam como "other"

### PUT /sadmin/projects/:id/plan

Body: `{ planKey: 'starter' | 'pro' | 'business' | 'free' }`

Lógica:
1. **Validação:** `planKey` deve estar em `['free', 'starter', 'pro', 'business']`. Rejeitar qualquer outro valor com 400 `{ error: 'Invalid plan key' }`
2. `getPlan(planKey)` para obter dados do plano
3. `Project.findByIdAndUpdate(id, { 'profile.name': plan.name, 'profile.type': plan.type, 'profile.agents': plan.agents, 'profile.quotes': plan.quotes, 'profile.customization': plan.customization })`
4. Se mudando para free, limpar mandateId, pendingPlan, billingPeriod
5. **Warning mandate ativo:** Se o projeto tem `profile.mandateId` e o admin está mudando de plano, incluir no response `{ warning: 'Project has active CasePay mandate. The mandate will continue billing at the previous amount. Consider canceling the mandate.' }`

### PUT /sadmin/projects/:id/trial

Body: `{ trialDays: 14 }`

Lógica:
1. Se projeto tem `profile.type === 'payment'`, retornar warning: `{ warning: 'Project has active payment. Trial extension has no effect on paid plans.' }`
2. `Project.findByIdAndUpdate(id, { 'profile.trialDays': trialDays })` 
3. O virtual field `trialDaysLeft` recalcula automaticamente

### PUT /sadmin/projects/:id/quotas

Body: `{ contacts: 500, platforms: 3, agents: 10, chatbots: 15, kbs: 5 }`

Lógica: merge no `profile.quotes` existente + update de `profile.agents`:
```javascript
const BOUNDS = { contacts: [0, 1000000], platforms: [0, 100], agents: [0, 10000], chatbots: [0, 10000], kbs: [0, 10000] };
const update = {};
for (const [key, val] of Object.entries(body)) {
  if (BOUNDS[key] && typeof val === 'number' && val >= BOUNDS[key][0] && val <= BOUNDS[key][1]) {
    if (key === 'agents') update['profile.agents'] = val;
    else update['profile.quotes.' + key] = val;
  }
}
if (Object.keys(update).length === 0) return res.status(400).json({ error: 'No valid quota fields' });
Project.findByIdAndUpdate(id, { $set: update });
```

**Validação:** Valores devem ser números >= 0 com limites máximos razoáveis. Rejeitar negativos e valores absurdos.

## Arquivos

### Server
| Arquivo | Ação |
|---|---|
| `routes/sadmin.js` | Criar — todos os endpoints admin |
| `middleware/super-admin-check.js` | Criar — middleware de verificação |
| `app.js` | Modificar — montar rota `/sadmin` |

### Dashboard
| Arquivo | Ação |
|---|---|
| `src/app/admin-panel/admin-panel.module.ts` | Criar |
| `src/app/admin-panel/admin-panel.component.ts/html/scss` | Criar — layout com nav interna |
| `src/app/admin-panel/admin-dashboard/admin-dashboard.component.ts/html` | Criar |
| `src/app/admin-panel/admin-projects/admin-projects.component.ts/html` | Criar |
| `src/app/admin-panel/admin-users/admin-users.component.ts/html` | Criar |
| `src/app/admin-panel/admin-payments/admin-payments.component.ts/html` | Criar |
| `src/app/services/admin.service.ts` | Criar |
| `src/app/core/super-admin.guard.ts` | Criar |
| `src/app/core/auth.service.ts` | Modificar — adicionar isSuperAdmin |
| `src/app/components/sidebar/sidebar.component.html` | Modificar — adicionar item Admin |
| `src/app/components/sidebar/sidebar.component.ts` | Modificar — adicionar isSuperAdmin |
| `src/app/app.module.ts` | Modificar — registrar AdminService, SuperAdminGuard |
| `src/app/app.routing.ts` | Modificar — adicionar rota /admin |
