# Onboarding Flow — ChatCase SaaS

## Overview

Public signup and onboarding flow for ChatCase (chatcase.com.br), built on top of Tiledesk's existing Angular dashboard. Users sign up, verify email, name their workspace, and land in the dashboard with a guided checklist.

## User Flow

```
chatcase.com.br → "Criar conta grátis"
  → /dashboard/#/signup (branding ChatCase)
  → Preenche: nome, email, senha
  → Redirect para /verify-email
  → Tela "Verifique seu email" (campo código + botão reenviar)
  → Clica no link ou digita código → email verificado
  → Redirect para /workspace-name
  → Digita nome da empresa → projeto criado (Free + trial 14 dias)
  → Redirect para /dashboard com checklist flutuante
```

## Decisions

- **Signup location:** Dentro do dashboard Angular existente (opção A), com branding ChatCase via brand.json
- **Email verification:** Obrigatória antes de criar workspace (previne abuso de trial com contas falsas)
- **Workspace name:** Solicitado ao usuário (não derivado do email)
- **Post-signup experience:** Checklist flutuante no canto inferior direito (não wizard bloqueante)
- **Trial expiration (dia 14):** Downgrade automático para plano Free (continua usando com limites reduzidos)
- **Billing gate:** Verificação de email obrigatória antes de poder assinar plano pago via CasePay

## Checklist Items

1. Verificar email
2. Conectar WhatsApp
3. Criar primeiro fluxo de atendimento
4. Personalizar mensagem de boas-vindas
5. Definir horário de atendimento
6. Convidar um agente

Each item links directly to the corresponding dashboard page. Progress persisted in localStorage. Dismissible/minimizable.

## Server Changes (tiledesk-server)

### Fix phone_1 index bug

Location: `app.js` (boot sequence)

On server startup, before accepting connections:
```javascript
db.users.dropIndex("phone_1")
db.users.createIndex({ phone: 1 }, { unique: true, sparse: true })
```

This permanently fixes the bug where only one user can register without a phone number.

### Trial expiration middleware

Location: middleware chain after `projectSetter`

On every project-scoped request, check `req.project.trialExpired`. If `true` and `profile.type !== 'payment'`, lazily downgrade the project profile to Free plan limits. No cron job needed — happens on first request after expiration.

```
if (project.trialExpired && project.profile.type !== 'payment') {
  → update project.profile with Free plan from plans.js
}
```

### Email verification gate on billing

Location: `pubmodules/billing/index.js` — POST `/subscribe`

Before creating a CasePay mandate, check `req.user.emailverified`. If `false`, return `403 { error: "email_not_verified" }`.

## Dashboard Changes (tiledesk-dashboard)

### brand.json updates

- Logo: ChatCase logo
- Colors: ChatCase brand colors
- Privacy/terms links: chatcase.com.br URLs
- Hide Google Auth button (if not needed)

### Modify: signup.component

- Apply ChatCase branding
- After successful signup: redirect to `/verify-email` instead of auto-login
- Do NOT auto-create project (remove the existing `createNewProject()` call)

### New: verify-email component

Route: `/verify-email`

- Shows: "Enviamos um código para redacted@example.invalid"
- Input field for verification code
- "Reenviar email" button (calls existing resend endpoint)
- On success: auto-login + redirect to `/workspace-name`

### New: workspace-name component

Route: `/workspace-name`

Guard: requires authenticated user with verified email.

- Shows: single input "Como se chama sua empresa?"
- Button: "Criar workspace"
- Calls `projectService.createProject(name, 'signup')`
- On success: redirect to `/project/:id/home`

### New: onboarding-checklist component

Injected in the main dashboard layout for new projects.

- Fixed overlay, bottom-right corner
- 6 checklist items with direct links
- Visual progress bar (e.g., "2 de 6 completos")
- Close/minimize button
- State persisted in localStorage keyed by project ID
- Show condition: project age < 30 days AND not all items completed AND not dismissed

### Routing changes (app.routing.ts)

Add routes:
- `/verify-email` → VerifyEmailComponent (no auth guard)
- `/workspace-name` → WorkspaceNameComponent (auth guard + email verified guard)

Modify existing post-signup redirect logic in `signup.component.ts` to go to `/verify-email`.

## Out of Scope

- Pricing page in dashboard (separate task)
- Transactional emails beyond verification (welcome, trial expiring, etc.)
- Super-admin panel
- Landing page changes on chatcase.com.br
- Email template customization
