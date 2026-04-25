# Onboarding Flow — ChatCase SaaS

## Visão Geral

Fluxo de signup público e onboarding para o ChatCase (chatcase.com.br), construído sobre o dashboard Angular existente do Tiledesk. O usuário se cadastra, verifica o email, nomeia seu workspace e entra no dashboard com um checklist guiado.

## Pré-requisitos

- SMTP configurado no docker-compose (`EMAIL_ENABLED=true`, `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USERNAME`, `EMAIL_PASSWORD`, `EMAIL_FROM_ADDRESS`)
- `TRIAL_MODE_ENABLED=true` no server
- `COMMUNITY_VERSION=false` e `QUOTES_ENABLED=true`
- Fix do índice `phone_1` aplicado (ver seção abaixo)

## Fluxo do Usuário

```
chatcase.com.br → "Criar conta grátis"
  → /dashboard/#/signup (branding ChatCase)
  → Preenche: nome, email, senha
  → Auto-login (autenticado, email NÃO verificado)
  → Redirect para /verify-email
  → Tela "Verifique seu email" (campo código + botão reenviar)
  → Digita código ou clica link no email → email verificado
  → Redirect para /workspace-name
  → Digita nome da empresa → projeto criado (plano Pro trial 14 dias)
  → Redirect para /project/:id/home com checklist flutuante
```

### Fluxos alternativos

- **Email já cadastrado:** Signup retorna erro → dashboard mostra "Email já cadastrado" com link para `/signin`
- **Email errado no signup:** Tela verify-email mostra link "Usou o email errado? Cadastre-se novamente" → volta para `/signup`
- **Acesso direto a /workspace-name com projeto existente:** Guard redireciona para `/projects`
- **Acesso direto a /verify-email sem login:** Guard redireciona para `/signup`

## Decisões

- **Signup:** Dentro do dashboard Angular existente, com branding ChatCase via brand.json
- **Verificação de email:** Obrigatória antes de criar workspace (previne abuso de trial com contas falsas)
- **Workspace name:** Solicitado ao usuário (não derivado do email)
- **Plano do trial:** Pro por 14 dias (usuário experimenta todas as features premium)
- **Trial expirado:** Downgrade automático para Free (continua usando com limites reduzidos: 1 agente, 2 chatbots, sem WhatsApp)
- **Post-signup:** Checklist flutuante no canto inferior direito (não wizard bloqueante)
- **Gate de billing:** Verificação de email obrigatória antes de assinar plano pago via CasePay

## Checklist Items

1. Conectar WhatsApp
2. Criar primeiro fluxo de atendimento
3. Personalizar mensagem de boas-vindas
4. Definir horário de atendimento
5. Convidar um agente

Cada item linka direto para a página correspondente no dashboard. Progresso persistido em localStorage por project ID. Minimizável e dispensável. Condição de exibição: projeto com menos de 30 dias E nem todos os itens completos E não dispensado.

## Mudanças no Server (tiledesk-server)

### Fix permanente do índice phone_1

Local: `app.js` (sequência de boot)

No startup do server, antes de aceitar conexões:

```javascript
const db = mongoose.connection.db;
try {
  await db.collection('users').dropIndex('phone_1');
} catch (e) {}
await db.collection('users').createIndex(
  { phone: 1 },
  { unique: true, sparse: true }
);
```

Resolve permanentemente o bug onde apenas um usuário consegue se registrar sem telefone. O `sparse: true` faz o MongoDB ignorar documentos onde `phone` é null.

### Middleware de trial expiration

Local: middleware chain após `projectSetter`

Em toda request com escopo de projeto, checar `req.project.trialExpired`. Se expirado e não é assinante, fazer downgrade atômico para Free.

```javascript
if (project.trialExpired && project.profile.type !== 'payment') {
  await Project.findOneAndUpdate(
    {
      _id: project._id,
      'profile.type': { $ne: 'payment' },
    },
    {
      $set: {
        'profile.name': freePlan.name,
        'profile.type': freePlan.type,
        'profile.agents': freePlan.agents,
        'profile.quotes': freePlan.quotes,
        'profile.customization': freePlan.customization,
      }
    }
  );
}
```

O `findOneAndUpdate` com condição garante atomicidade — requests concorrentes não causam race condition. Sem necessidade de cron job.

### Gate de verificação de email no billing

Local: `pubmodules/billing/index.js` — `POST /subscribe`

Antes de criar mandato no CasePay, checar `req.user.emailverified`. Se `false`, retornar:

```json
{ "status": 403, "error": "email_not_verified" }
```

### Criação de projeto com plano Pro trial

Local: lógica de criação de projeto (quando vem do onboarding)

O projeto criado via onboarding deve receber o plano Pro com trial de 14 dias:

```javascript
profile: {
  name: 'Pro',
  type: 'free',
  trialDays: 14,
  agents: getPlan('pro').agents,
  quotes: getPlan('pro').quotes,
  customization: getPlan('pro').customization
}
```

O `type: 'free'` combinado com features do Pro é o que ativa a lógica de trial. O `trialExpired` virtual field conta 14 dias a partir de `createdAt`. Quando expira, o middleware faz downgrade para Free.

## Mudanças no Dashboard (tiledesk-dashboard)

### brand.json

- Logo: ChatCase
- Cores: paleta ChatCase
- Links de privacidade/termos: chatcase.com.br
- `display_google_auth_btn`: definir conforme necessidade

### Modificar: signup.component

- Aplicar branding ChatCase
- Após signup bem-sucedido: auto-login (já existe) + redirect para `/verify-email`
- Remover chamada `createNewProject()` do fluxo de signup
- Tratar erro "Email already registered": mostrar mensagem com link para `/signin`

### Novo: verify-email component

Rota: `/verify-email`
Guard: autenticado + email NÃO verificado. Se não autenticado → `/signup`. Se já verificado → `/workspace-name`.

- Mostra: "Enviamos um código para {email do usuário logado}"
- Campo input para código de verificação
- Botão "Reenviar email" (chama endpoint existente de reenvio)
- Link "Usou o email errado? Cadastre-se novamente" → `/signup`
- Ao verificar com sucesso: atualiza estado do user → redirect para `/workspace-name`

O email é obtido via `auth.user_bs` (usuário já está logado via auto-login do signup).

### Novo: workspace-name component

Rota: `/workspace-name`
Guard: autenticado + email verificado + sem projetos. Se já tem projeto → `/projects`.

- Mostra: campo "Como se chama sua empresa?"
- Botão: "Criar workspace"
- Chama `projectService.createProject(name, 'signup')`
- Ao criar com sucesso: redirect para `/project/:id/home`

### Novo: onboarding-checklist component

Injetado no layout principal do dashboard para projetos novos.

- Overlay fixo, canto inferior direito
- 5 itens do checklist com links diretos para cada configuração
- Barra de progresso visual (ex: "2 de 5 completos")
- Botão fechar/minimizar
- Estado persistido em localStorage com chave `checklist_{projectId}`
- Condição de exibição: `project.createdAt` < 30 dias atrás E nem todos completos E não dispensado

### Mudanças no routing (app.routing.ts)

Adicionar rotas:
- `/verify-email` → VerifyEmailComponent (guard: autenticado + não verificado)
- `/workspace-name` → WorkspaceNameComponent (guard: autenticado + verificado + sem projetos)

Modificar lógica pós-signup em `signup.component.ts` para redirecionar para `/verify-email`.

## Fora de Escopo

- Pricing page no dashboard (tarefa separada)
- Emails transacionais além da verificação (boas-vindas, trial expirando)
- Super-admin panel
- Mudanças na landing page chatcase.com.br
- Customização de templates de email
