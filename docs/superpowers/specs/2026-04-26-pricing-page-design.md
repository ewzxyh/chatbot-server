# Pricing Page — ChatCase SaaS

## Objetivo

Criar a página de planos e assinatura no dashboard Angular, permitindo que owners de projetos vejam os planos disponíveis (Iniciante/Standard/Pro/Enterprise/Scale+), comparem features, visualizem uso atual, e assinem/cancelem via CasePay PIX Automático. Inclui enforcement server-side de quotas de contatos, plataformas e membros.

## Mapeamento de Planos

| Key MongoDB | displayName | Mensal | Anual (15% desc) | Agentes | Contatos | Plataformas |
|---|---|---|---|---|---|---|
| `free` | Iniciante | Grátis | Grátis | 1 | 200 | 1 |
| `starter` | Standard | R$279 | R$2.845,80 | 5 | 1.000 | 1 |
| `pro` | Pro | R$549 | R$5.599,80 | 5 | 11.000 | 5 |
| `business` | Enterprise | R$997 | R$10.169,40 | 10 | 50.000 | 5 |

- **Scale+**: Não existe no backend. Card estático no frontend com "Fale com especialista" (link WhatsApp).
- Keys internos (`free`, `starter`, `pro`, `business`) são preservados no MongoDB. O campo `displayName` é usado apenas na UI.

## Arquitetura

### Dashboard (Angular)

**Novo módulo:** `src/app/casepay-pricing/`
- `casepay-pricing.module.ts` — lazy-loaded module
- `casepay-pricing.component.ts/html/scss` — página de pricing

**Novo serviço:** `src/app/services/casepay.service.ts`
- HTTP client para `/modules/payments/casepay/*` (plans, subscribe, cancel, status, history)
- Segue padrão manual de HttpHeaders: injeta `AuthService`, subscribe em `user_bs`, armazena token, passa em cada request
- O codebase tem um `LogRequestsInterceptor` (logging), mas serviços de billing usam headers manuais por consistência com ProjectService e AppStoreService

**Métodos do casepay.service.ts:**
- `getPlans(): Observable<Plan[]>` — GET /plans
- `subscribe(projectId: string, planKey: string, billingPeriod: 'monthly'|'annual'): Observable<{mandateId, authorizeUrl, status}>` — POST /subscribe
- `cancel(projectId: string): Observable<{status}>` — POST /cancel
- `getStatus(projectId: string): Observable<ProjectStatus>` — GET /status/:projectId
- `getHistory(projectId: string): Observable<Payment[]>` — GET /history/:projectId

**Routing (`app.routing.ts`):** 3 rotas devem ser swapped para `CasepayPricingModule`:
- `project/:projectid/pricing` (principal)
- `project/:projectid/pricing/te` (trial expired redirect — usado por app.component.ts e sidebar.component.ts)
- `project/:projectid/chat-pricing` (chat panel pricing)

**Guards:** Remover `RoleGuard` das 3 rotas. Manter apenas `AuthGuard`. O check de role (owner vs agent) é feito dentro do componente via `ProjectPlanService.projectPlan$` → `user_role`.

**Integração com serviços existentes:**
- Consome `ProjectPlanService.projectPlan$` para estado do plano atual e role do usuário
- NÃO duplica lógica de ProjectPlanService

### Server (Node.js)

**Arquivos modificados:**
- `pubmodules/billing/plans.js` — displayName, monthlyPrice, annualPrice, contacts/platforms em quotes
- `pubmodules/billing/index.js` — subscribe com billingPeriod, cancel mandate antigo, idempotência, status com usage
- `pubmodules/billing/casepay.js` — sem mudanças estruturais (já suporta interval e firstPaymentAmount)
- `models/profile.js` — contacts/platforms em quotes, billingPeriod field
- `services/leadService.js` — novo método checkContactsQuota()
- `routes/lead.js` — check de quota hard limit
- `routes/integration.js` — check de quota plataformas
- `routes/project_user.js` — check de quota membros
- `services/QuoteManager.js` — adicionar contacts/platforms/members ao PLANS_LIST

**Nenhum arquivo novo de middleware.** Enforcement segue padrão existente (inline checks).

### Rotas Stripe Legadas

As rotas `/payments`, `/success`, `/canceled` (PaymentsListModule, PaymentSuccessModule, PaymentCanceledModule) são módulos Stripe-era independentes. Decisão: **manter intocadas** nesta versão. Não são referenciadas pelo novo componente CasePay. Remoção/substituição fica para uma futura limpeza.

### Formato do GET /plans

O endpoint `GET /modules/payments/casepay/plans` já existe e retorna `getAllPlans()`:
```javascript
[
  { key: 'free', name: 'Free', displayName: 'Iniciante', type: 'free', agents: 1,
    monthlyPrice: 0, annualPrice: 0, quotes: { chatbots: 2, kbs: 1, ... , contacts: 200, platforms: 1 },
    customization: { whatsapp: false, ... } },
  { key: 'starter', name: 'Starter', displayName: 'Standard', ... },
  ...
]
```
O frontend usa `displayName` para labels, `monthlyPrice`/`annualPrice` para preços, `quotes` e `customization` para features.

## UI e Fluxo do Usuário

### Layout da Página

- Header: "Escolha seu plano" + toggle Mensal/Anual
- 5 cards lado a lado: Iniciante | Standard | **Pro (destaque "Recomendado")** | Enterprise | Scale+
- Cada card: displayName, preço (atualiza com toggle), lista de features, botão de ação
- Barras de uso abaixo dos cards: "Contatos: 145/200", "Plataformas: 1/1", "Membros: 3/5"

### Features Exibidas por Card

Cada card lista as features derivadas dos dados do plano:
- Número de agentes: "X agentes" (do campo `agents`)
- Número de contatos: "X contatos" (de `quotes.contacts`)
- Número de plataformas: "X plataformas" (de `quotes.platforms`)
- Chatbots: "X chatbots" (de `quotes.chatbots`)
- Canais disponíveis: lista dos canais com `true` em `customization` (WhatsApp, Telegram, etc.)
- Features booleanas: checkmarks para copilot, webhook, widget unbranding, SMTP, knowledge bases
- Iniciante (Free): mostra "1 agente", "200 contatos", "1 plataforma", "Sem WhatsApp"
- Scale+: "Preços exclusivos", "Suporte dedicado", "Integrações personalizadas", "Consultoria"

### Estados dos Cards

| Situação | Card do plano atual | Outros cards |
|---|---|---|
| No Free | "Plano Atual" sem botão | "Assinar" habilitado |
| Em trial Pro | "Em teste — X dias restantes" + "Assinar" habilitado | "Assinar" habilitado |
| Plano pago ativo | "Plano Atual" desabilitado + link "Cancelar assinatura" no rodapé | "Upgrade" habilitado |
| Trial expirado | Banner topo: "Seu período de teste expirou" | "Assinar" habilitado |

### Visibilidade por Role

- **Owner:** Vê todos os botões de ação (Assinar, Cancelar, Upgrade)
- **Non-owner (agent/admin):** Vê a página e features mas botões substituídos por "Contate o proprietário do projeto"

### Rota /pricing/te

Quando o componente detecta `/te` na URL, mostra banner de trial expirado no topo forçando escolha de plano.

### Scale+ Card

Card estático sem lógica de billing:
- Texto: "Preços exclusivos, suporte dedicado, integrações personalizadas"
- Botão: "Fale com especialista" → abre WhatsApp com mensagem pré-preenchida incluindo projectId

## Fluxo de Assinatura

1. Usuário clica "Assinar" no card
2. Botão desabilitado imediatamente + spinner (double-click guard)
3. Frontend chama `POST /subscribe` com `{ projectId, planKey, billingPeriod: 'monthly'|'annual' }`
4. Backend:
   a. Verifica email verificado (403 `email_not_verified` se não)
   b. Verifica se já existe mandate pendente → retorna `authorizeUrl` existente (idempotência)
   c. Se existe `profile.mandateId` ativo (upgrade) → cancela mandate antigo via `casepay.cancelMandate()`
   d. Cria mandate no CasePay:
      - Monthly: `{ amount: monthlyPrice, interval: 'MONTHLY' }`
      - Annual: `{ amount: annualPrice, interval: 'YEARLY', firstPaymentAmount: annualPrice }`
   e. Salva mandateId, pendingPlan, billingPeriod no profile. **IMPORTANTE:** Também seta `profile.type: 'payment'` imediatamente para evitar que o trial-expiration middleware faça downgrade durante a janela entre criação do mandate e autorização via webhook.
   f. Retorna `{ mandateId, authorizeUrl, status }`
5. Frontend recebe authorizeUrl → abre em nova aba
6. Página entra em estado "Aguardando autorização..." com polling `/status/:projectId` a cada 5s
7. Botão fallback "Verificar pagamento" caso polling falhe
8. Quando mandate é autorizado (detectado via polling) → UI atualiza mostrando plano novo

### Tratamento de Erros

- 403 `email_not_verified` → toast explicativo + botão "Verificar email" → navega para `/verify-email-waiting`
- 400/500 → toast "Erro ao processar. Tente novamente."
- Loading: skeleton cards enquanto `/plans` carrega
- Falha de API: banner de erro com botão retry

## Fluxo de Cancelamento

1. Link "Cancelar assinatura" visível no rodapé do card do plano ativo (só para owners)
2. Modal de confirmação: "Tem certeza? Seu plano será alterado para Iniciante."
3. `POST /cancel` → backend cancela mandate + downgrade para Free
4. UI atualiza

## Fluxo de Upgrade

1. Mesmo fluxo de assinatura
2. Backend cancela mandate antigo automaticamente antes de criar o novo
3. Webhook ignora eventos de mandateIds que não batem com o atual do projeto

## Downgrade Entre Planos Pagos

V1: Não suportado. Usuário só pode cancelar (volta ao Free) e depois assinar outro plano. Downgrade direto entre planos pagos fica para V2.

## Billing Anual

- CasePay `createMandate()` já aceita param `interval` (default 'MONTHLY') e `firstPaymentAmount`
- Para anual: `interval: 'YEARLY'`, `firstPaymentAmount: annualPrice`
- Webhook handler deve verificar `profile.billingPeriod`:
  - 'monthly': subEnd = now + 1 mês + 3 dias
  - 'annual': subEnd = now + 12 meses + 3 dias
- Mesma lógica em `payment_request/updated` (AUTHORIZED) e `automatic_pix_payment/completed`

**Risco:** Verificar se a API CasePay aceita `'YEARLY'` como valor de interval antes da implementação. Alternativa fallback: usar `interval: 'MONTHLY'` com amount = preço mensal com desconto anual (R$237,15 para Standard).

## Quota Enforcement

### Princípio Geral

Enforcement segue o padrão existente do Tiledesk: checks inline nos route handlers e services, usando `countDocuments` do MongoDB para limites totais (não Redis counters, que são para limites por ciclo).

### Contatos

**Método:** `leadService.checkContactsQuota(id_project)` — novo método que:
1. Carrega projeto via `Project.findById(id_project).select('profile').lean()`
2. Conta leads: `Lead.countDocuments({ id_project, status: LeadConstants.NORMAL })` (status = 100, exclui TEMP=50 e DELETED=1000)
3. Compara contra `project.profile.quotes.contacts` (override) ou `getPlanLimits().contacts` (padrão)
4. Retorna `{ allowed: boolean, current, limit }`

**Hard limit** (criação manual via API):
- `routes/lead.js` POST / — chama `checkContactsQuota()` antes de criar. Se `!allowed`, retorna 403 `{ error: 'contacts_limit_reached', limit, current }`

**Soft limit** (criação implícita por visitor):
- `leadService.createWitId()` e `leadService.updateWitId()` (que tem `upsert: true` na linha 137) — chamam `checkContactsQuota()`. Se `!allowed`, o lead é criado normalmente MAS emite evento `lead.quota.exceeded` para notificação do owner
- Visitante nunca é bloqueado de iniciar uma conversa

**Alertas:** Nos thresholds 50/75/95/100%:
- **Detecção:** O `checkContactsQuota()` calcula o percentual de uso. Se cruzou um threshold, emite evento `lead.quota.threshold` com `{ projectId, percent, current, limit }`.
- **In-app:** A pricing page e a navbar mostram indicador visual (barra amarela em 75%, vermelha em 95%+). Dados vêm do `/status` endpoint (campo `usage`).
- **Email (futuro):** Seguir padrão do QuoteManager que envia email via `sendEmailIfQuotaExceeded()`. Na V1, apenas indicador visual — email fica para V2.

### Plataformas

**Local:** Inline em `routes/integration.js` POST /

**Lógica:**
1. Verifica se a integração é um canal: `name` está em `['whatsapp', 'telegram', 'messenger', 'sms', 'voice', 'voice_twilio']`
2. Se não é canal → permite sem check
3. Se é canal → verifica se já existe: `Integration.findOne({ id_project, name })`
4. Se existe → é update de config, permite sem check
5. Se não existe → é novo canal. Conta `Integration.countDocuments({ id_project, name: { $in: channelNames } })`
6. Compara contra `project.profile.quotes.platforms`
7. Se excedeu → 403 `{ error: 'platforms_limit_reached', limit, current }`

`req.project` está disponível via `projectSetter` middleware (app.js:585).

### Membros

**Local:** Inline em `routes/project_user.js` POST `/invite`

**Lógica:**
1. `req.project` já está disponível (usado na linha 44)
2. Conta: `Project_user.countDocuments({ id_project: req.projectid, status: 'active' })`
3. Compara contra `req.project.profile.agents`
4. Se excedeu → 403 `{ error: 'members_limit_reached', limit, current }`

### PLANS_LIST Sync

Duas fontes de verdade que devem ser atualizadas com contacts/platforms/members:
- Server: `services/QuoteManager.js` → PLANS_LIST
- Dashboard: `src/app/utils/util.ts` → PLANS_LIST

## Post-Downgrade: Quota Overflow

Quando um projeto é downgraded (ex: Pro→Free), recursos existentes que excedem os novos limites ficam em modo **read-only/grandfathered**:

- **Contatos:** Permanecem todos. Novos não podem ser criados (hard limit). Novos visitantes geram notificação (soft limit).
- **Plataformas:** Canais conectados continuam funcionando. Não pode adicionar novos. Se removido, não pode re-adicionar se exceder limite.
- **Membros:** Permanecem ativos. Não pode convidar novos.

O sistema NÃO deleta/desativa dados automaticamente no downgrade. Owner recebe notificação visual na pricing page e navbar: "Você excedeu os limites do seu plano atual."

## Backend Updates

### plans.js

```javascript
{
  free: {
    name: 'Free', displayName: 'Iniciante',
    type: 'free',
    agents: 1,
    monthlyPrice: 0, annualPrice: 0,
    quotes: { chatbots: 2, kbs: 1, namespace: 1, contacts: 200, platforms: 1 },
    customization: {
      whatsapp: false, telegram: false, messenger: false,
      copilot: false, webhook: false, widgetUnbranding: false,
      smtpSettings: false, knowledgeBases: true, chatbot: true
    }
  },
  starter: {
    name: 'Starter', displayName: 'Standard',
    type: 'payment',
    agents: 5,
    monthlyPrice: 279, annualPrice: 2845.80,
    quotes: { chatbots: 5, kbs: 3, namespace: 3, contacts: 1000, platforms: 1 },
    customization: {
      whatsapp: true, telegram: true, messenger: false,
      copilot: false, webhook: true, widgetUnbranding: true,
      smtpSettings: false, knowledgeBases: true, reindex: false, chatbot: true
    }
  },
  pro: {
    name: 'Pro', displayName: 'Pro',
    type: 'payment',
    agents: 5,
    monthlyPrice: 549, annualPrice: 5599.80,
    quotes: { chatbots: 20, kbs: 10, namespace: 10, contacts: 11000, platforms: 5 },
    customization: {
      whatsapp: true, telegram: true, messenger: true,
      copilot: true, webhook: true, widgetUnbranding: true,
      smtpSettings: true, knowledgeBases: true, reindex: true, chatbot: true
    }
  },
  business: {
    name: 'Business', displayName: 'Enterprise',
    type: 'payment',
    agents: 10,
    monthlyPrice: 997, annualPrice: 10169.40,
    quotes: { chatbots: 100, kbs: 50, namespace: 50, contacts: 50000, platforms: 5 },
    customization: {
      whatsapp: true, telegram: true, messenger: true,
      copilot: true, webhook: true, widgetUnbranding: true,
      smtpSettings: true, knowledgeBases: true, reindex: true, chatbot: true
    }
  }
}
```

### Subscribe Endpoint

`POST /modules/payments/casepay/subscribe`

Body: `{ projectId, planKey, billingPeriod: 'monthly'|'annual' }`

Lógica atualizada:
1. Verificar email (DB fresh via User.findById)
2. Verificar mandate pendente → retornar authorizeUrl existente (idempotência)
3. Se `profile.mandateId` ativo → `casepay.cancelMandate()` antes de criar novo
4. Calcular amount baseado em billingPeriod: `plan.monthlyPrice` ou `plan.annualPrice`
5. `casepay.createMandate({ amount, interval, firstPaymentAmount })` com interval correto
6. Salvar mandateId, pendingPlan, billingPeriod, paymentProvider no profile

### Status Endpoint

`GET /modules/payments/casepay/status/:projectId`

Response atualizado:
```javascript
{
  plan: 'Starter',
  displayName: 'Standard',
  type: 'payment',
  billingPeriod: 'monthly',
  usage: {
    contacts: { current: 145, limit: 1000 },
    platforms: { current: 1, limit: 1 },
    agents: { current: 3, limit: 5 }
  },
  mandateId: '...',
  mandateStatus: 'active',
  trialExpired: false,
  trialDaysLeft: 10
}
```

Contagens:
- contacts: `Lead.countDocuments({ id_project, status: 100 })`
- platforms: `Integration.countDocuments({ id_project, name: { $in: channelNames } })`
- agents: `Project_user.countDocuments({ id_project, status: 'active' })`

### Profile.js

Campos novos em quotes: `contacts` (Number), `platforms` (Number).
Campo novo no profile: `billingPeriod` (String).

### Webhook Handler

Atualizar `payment_request/updated` e `automatic_pix_payment/completed`:
- Ler `project.profile.billingPeriod`
- Monthly: `subEnd = now + 1 mês + 3 dias`
- Annual: `subEnd = now + 12 meses + 3 dias`

**Guard de eventId:** Se `eventId` é undefined/null no payload do webhook, rejeitar com 400 `{ error: 'missing_event_id' }`. Sem eventId válido, a idempotência não funciona e webhooks duplicados podem processar duas vezes. Alternativa: se eventId ausente, gerar um hash do payload como fallback de deduplicação — mas rejeitar é mais seguro.
