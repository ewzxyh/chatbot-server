# Emails Transacionais — ChatCase SaaS

## Objetivo

Implementar 5 emails transacionais automáticos para o ciclo de vida do usuário no SaaS: boas-vindas, confirmação de pagamento/upgrade, trial expirando, trial expirado, cancelamento.

## Emails

| # | Email | Quando dispara | Tipo | Template |
|---|---|---|---|---|
| 1 | Boas-vindas | Após signup bem-sucedido | Event-driven | `welcome.html` |
| 2 | Pagamento confirmado / Upgrade | Webhook `payment_request/updated` status AUTHORIZED | Event-driven | `paymentConfirmed.html` |
| 3 | Trial expirando | Cron diário — projetos com trialDaysLeft === 3 | Scheduled | `trialExpiring.html` |
| 4 | Trial expirado | Middleware `trial-expiration.js` após downgrade automático | Event-driven | `trialExpired.html` |
| 6 | Cancelamento | Cancel handler após downgrade para Free | Event-driven | `planCanceled.html` |

## Padrão Existente

O emailService do Tiledesk usa:
- **Nodemailer** com SMTP configurado via env vars (EMAIL_HOST, EMAIL_PORT, etc.)
- **Templates Handlebars** em `template/email/*.html`
- **Método `send()`** core que aplica template, compila com dados, e envia
- **Override por env var**: cada template pode ser sobrescrito via env var (ex: `EMAIL_WELCOME_HTML_TEMPLATE`)
- **Override por projeto**: projeto pode ter SMTP próprio via `project.settings.email.config`

Cada novo email segue esse padrão exato.

## Novos Métodos no emailService.js

### sendWelcomeEmail(to, user)
- Template: `welcome.html`
- Dados: `{{ user.firstname }}`, `{{ brandName }}`, `{{ loginUrl }}`
- Chamado em: `routes/auth.js` após signup, junto com o sendVerifyEmailAddress

### sendPaymentConfirmedEmail(to, user, projectName, planName, amount)
- Template: `paymentConfirmed.html`
- Dados: `{{ user.firstname }}`, `{{ projectName }}`, `{{ planName }}`, `{{ amount }}`
- Chamado em: `pubmodules/billing/index.js` webhook handler, bloco AUTHORIZED

### sendTrialExpiringEmail(to, user, projectName, daysLeft)
- Template: `trialExpiring.html`
- Dados: `{{ user.firstname }}`, `{{ projectName }}`, `{{ daysLeft }}`, `{{ pricingUrl }}`
- Chamado por: cron task `trialExpiringNotificationTask.js`

### sendTrialExpiredEmail(to, user, projectName)
- Template: `trialExpired.html`
- Dados: `{{ user.firstname }}`, `{{ projectName }}`, `{{ pricingUrl }}`
- Chamado em: `middleware/trial-expiration.js` após downgrade automático

### sendPlanCanceledEmail(to, user, projectName)
- Template: `planCanceled.html`
- Dados: `{{ user.firstname }}`, `{{ projectName }}`, `{{ pricingUrl }}`
- Chamado em: `pubmodules/billing/index.js` cancel handler

## Templates

Todos os templates seguem o layout visual dos templates existentes do Tiledesk:
- HTML simples com inline CSS
- Header com logo/brand name
- Body com saudação, mensagem, CTA button
- Footer com nome da empresa e link de contato
- Textos em Português (PT-BR)
- Brand name via `{{ brandName }}` (vem de env var BRAND_NAME ou 'ChatCase')

### Template base (estrutura comum):

```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="text-align: center; padding: 20px 0;">
    <h2 style="color: #333;">{{ brandName }}</h2>
  </div>
  <div style="background: #f9f9f9; border-radius: 8px; padding: 24px;">
    <p>Ola {{ user.firstname }},</p>
    <!-- conteúdo específico do email -->
  </div>
  <div style="text-align: center; padding: 16px; font-size: 12px; color: #999;">
    {{ brandName }} — {{ companyUrl }}
  </div>
</body>
</html>
```

### Conteúdo por email:

**welcome.html:**
- "Bem-vindo ao {{ brandName }}!"
- "Sua conta foi criada com sucesso."
- CTA: "Acessar Dashboard" → loginUrl

**paymentConfirmed.html:**
- "Pagamento confirmado!"
- "Recebemos seu pagamento de R$ {{ amount }} para o plano {{ planName }} do projeto {{ projectName }}."
- CTA: "Acessar projeto" → projectUrl

**trialExpiring.html:**
- "Seu período de teste está acabando"
- "Restam {{ daysLeft }} dias do período de teste Pro do projeto {{ projectName }}."
- "Escolha um plano para continuar com todos os recursos."
- CTA: "Ver planos" → pricingUrl

**trialExpired.html:**
- "Seu período de teste expirou"
- "O período de teste do projeto {{ projectName }} expirou. Seu plano foi alterado para Iniciante (gratuito)."
- "Para recuperar os recursos Pro, escolha um plano pago."
- CTA: "Fazer upgrade" → pricingUrl

**planUpgraded.html:**
- "Plano atualizado com sucesso!"
- "O projeto {{ projectName }} agora está no plano {{ planName }} ({{ billingPeriod }})."
- "Valor: R$ {{ amount }}"
- CTA: "Acessar projeto" → projectUrl

**planCanceled.html:**
- "Assinatura cancelada"
- "A assinatura do projeto {{ projectName }} foi cancelada. Seu plano foi alterado para Iniciante (gratuito)."
- "Você pode assinar novamente a qualquer momento."
- CTA: "Ver planos" → pricingUrl

## Triggers — Onde adicionar no código

### 1. Boas-vindas (routes/auth.js)

No signup handler, após `emailService.sendVerifyEmailAddress(...)`, adicionar:
```javascript
emailService.sendWelcomeEmail(savedUser.email, savedUser);
```

### 2 e 5. Pagamento confirmado + Upgrade (pubmodules/billing/index.js)

No webhook handler, bloco `payment_request/updated` com status AUTHORIZED, após o `Project.findByIdAndUpdate`:
```javascript
var ownerPU = await Project_user.findOne({ id_project: project._id, role: 'owner', status: 'active' });
if (ownerPU) {
  var owner = await User.findById(ownerPU.id_user);
  if (owner && owner.email) {
    emailService.sendPaymentConfirmedEmail(owner.email, owner, project.name, plan.displayName || plan.name, amount, project.profile.billingPeriod || 'monthly');
  }
}
```

### 3. Trial expirando (nova scheduled task)

Criar `pubmodules/scheduler/tasks/trialExpiringNotificationTask.js`:
- Cron: `0 9 * * *` (9h da manhã, diariamente)
- Query: busca projetos com `profile.type === 'free'` e trialDaysLeft virtual field === 3
- Para cada projeto: busca owner, envia email
- Registrar no `taskRunner.js`

Nota: o virtual field `trialDaysLeft` não é queryable no MongoDB. A task deve calcular a data de criação + trialDays e comparar:
```javascript
var targetDate = new Date();
targetDate.setDate(targetDate.getDate() + 3);
// Projetos criados há (trialDays - 3) dias com type=free
var projects = await Project.find({ 'profile.type': 'free', 'profile.trialDays': { $exists: true } });
// Filtrar no JS: trialDaysLeft === 3
```

### 4. Trial expirado (middleware/trial-expiration.js)

Após o findOneAndUpdate que faz downgrade, adicionar envio de email COM flag de deduplicação.

Imports necessários no topo do middleware: Project_user, User, emailService.

Dentro do callback do findOneAndUpdate, APÓS o downgrade, verificar flag `trialExpiredNotified`:
- Se `!updatedProject.profile.trialExpiredNotified`: setar flag true no DB, buscar owner, enviar email
- O middleware roda a cada request — a flag garante envio único
- Flag `trialExpiredNotified` adicionada ao profile.js (Boolean)

### 6. Cancelamento (pubmodules/billing/index.js)

No cancel handler, após o downgrade para Free:
```javascript
var ownerPU = await Project_user.findOne({ id_project: projectId, role: 'owner', status: 'active' });
if (ownerPU) {
  var owner = await User.findById(ownerPU.id_user);
  if (owner && owner.email) {
    emailService.sendPlanCanceledEmail(owner.email, owner, project.name);
  }
}
```

## Deduplicação do Trial Expiring

Para evitar enviar o email de trial expirando mais de uma vez, usar uma flag no profile:
```javascript
'profile.trialExpiringNotified': true
```
A task verifica essa flag antes de enviar. O campo é resetado se o trial for estendido.

## Arquivos

### Criar
| Arquivo | Descrição |
|---|---|
| `template/email/welcome.html` | Template boas-vindas |
| `template/email/paymentConfirmed.html` | Template confirmação pagamento |
| `template/email/trialExpiring.html` | Template trial expirando |
| `template/email/trialExpired.html` | Template trial expirado |
| `template/email/planCanceled.html` | Template cancelamento |
| `pubmodules/scheduler/tasks/trialExpiringNotificationTask.js` | Cron task diária |

### Modificar
| Arquivo | Mudança |
|---|---|
| `services/emailService.js` | 5 novos métodos |
| `routes/auth.js` | Trigger welcome email no signup |
| `pubmodules/billing/index.js` | Trigger payment/upgrade/cancel emails |
| `middleware/trial-expiration.js` | Trigger trial expired email |
| `pubmodules/scheduler/taskRunner.js` | Registrar nova cron task |
| `models/profile.js` | Campos trialExpiringNotified e trialExpiredNotified (Boolean) |
