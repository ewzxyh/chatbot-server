# Onboarding Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Public signup → email verification → workspace creation → dashboard with guided checklist for ChatCase SaaS.

**Architecture:** Modify existing Tiledesk signup flow (Angular dashboard + Node.js server). Server gets 3 changes (index fix, trial middleware, email gate). Dashboard gets 4 changes (signup redirect, verify-email waiting page, workspace-name page, floating checklist). No new dependencies.

**Tech Stack:** Angular 14 (dashboard), Node.js/Express/Mongoose (server), MongoDB

**Spec:** `docs/superpowers/specs/2026-04-25-onboarding-design.md`

---

## File Map

### Server (C:\Users\enzo\tiledesk-server)

| File | Action | Purpose |
|---|---|---|
| `app.js` | Modify | Add phone_1 index fix on boot |
| `middleware/trial-expiration.js` | Create | Lazy downgrade when trial expires |
| `pubmodules/billing/index.js` | Modify | Add emailverified gate on /subscribe |

### Dashboard (C:\Users\enzo\tiledesk-dashboard)

| File | Action | Purpose |
|---|---|---|
| `src/assets/brand/brand.json` | Modify | ChatCase branding |
| `src/app/auth/signup/signup.component.ts` | Modify | Redirect to /verify-email-waiting, remove createNewProject |
| `src/app/verify-email-waiting/verify-email-waiting.module.ts` | Create | Lazy module |
| `src/app/verify-email-waiting/verify-email-waiting.component.ts` | Create | Code input + resend + wait |
| `src/app/verify-email-waiting/verify-email-waiting.component.html` | Create | Template |
| `src/app/verify-email-waiting/verify-email-waiting.component.scss` | Create | Styles |
| `src/app/workspace-name/workspace-name.module.ts` | Create | Lazy module |
| `src/app/workspace-name/workspace-name.component.ts` | Create | Name input + create project |
| `src/app/workspace-name/workspace-name.component.html` | Create | Template |
| `src/app/workspace-name/workspace-name.component.scss` | Create | Styles |
| `src/app/onboarding-checklist/onboarding-checklist.component.ts` | Create | Floating overlay logic |
| `src/app/onboarding-checklist/onboarding-checklist.component.html` | Create | Checklist template |
| `src/app/onboarding-checklist/onboarding-checklist.component.scss` | Create | Overlay styles |
| `src/app/app.module.ts` | Modify | Declare checklist component |
| `src/app/app.component.html` | Modify | Inject checklist overlay |
| `src/app/app.routing.ts` | Modify | Add new routes |

---

### Task 1: Fix phone_1 MongoDB Index (Server)

**Files:**
- Modify: `C:\Users\enzo\tiledesk-server\app.js`

- [ ] **Step 1: Find the boot sequence in app.js**

In `app.js`, locate the mongoose connection callback (around line 240). The index fix must run after mongoose connects but before the server accepts requests.

- [ ] **Step 2: Add the index fix**

In `app.js`, after the line `mongoose.connect(databaseUri, ...)` and inside the connection success callback, add:

```javascript
// Fix phone_1 unique index — allow multiple users without phone
try {
  var usersCollection = mongoose.connection.db.collection('users');
  usersCollection.dropIndex('phone_1').then(function() {
    winston.info('Dropped phone_1 index');
    usersCollection.createIndex({ phone: 1 }, { unique: true, sparse: true }).then(function() {
      winston.info('Recreated phone_1 index as sparse');
    });
  }).catch(function(e) {
    if (e.code === 27) {
      winston.debug('phone_1 index does not exist, skipping');
    } else {
      winston.warn('phone_1 index fix error: ' + e.message);
    }
  });
} catch(e) {
  winston.warn('phone_1 index fix error: ' + e.message);
}
```

Error code 27 = IndexNotFound, which means the fix already ran on a previous boot.

- [ ] **Step 3: Test manually**

```bash
cd C:\Users\enzo\tiledesk && docker compose up -d --build server
```

Wait for healthy, then test signup of two users without phone:

```bash
curl -s -X POST http://localhost:3000/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"redacted@example.invalid","password":"Test12345","firstname":"Test","lastname":"One"}'

curl -s -X POST http://localhost:3000/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"redacted@example.invalid","password":"Test12345","firstname":"Test","lastname":"Two"}'
```

Both should return `{ "success": true, ... }`.

- [ ] **Step 4: Verify in logs**

```bash
docker logs server 2>&1 | grep "phone_1"
```

Expected: `Dropped phone_1 index` and `Recreated phone_1 index as sparse`.

- [ ] **Step 5: Commit**

```bash
cd C:\Users\enzo\tiledesk-server
git add app.js
git commit -m "fix: recreate phone_1 index as sparse on boot

Fixes bug where only one user could register without a phone number.
The unique index on null values blocked all subsequent signups."
```

---

### Task 2: Trial Expiration Middleware (Server)

**Files:**
- Create: `C:\Users\enzo\tiledesk-server\middleware\trial-expiration.js`
- Modify: `C:\Users\enzo\tiledesk-server\app.js`

- [ ] **Step 1: Create the middleware file**

Create `C:\Users\enzo\tiledesk-server\middleware\trial-expiration.js`:

```javascript
var winston = require('../config/winston');
var Project = require('../models/project');
var { getPlan } = require('../pubmodules/billing/plans');

module.exports = function trialExpiration(req, res, next) {
  if (!req.project) return next();
  if (req.project.profile.type === 'payment') return next();
  if (!req.project.trialExpired) return next();

  var freePlan = getPlan('free');

  if (req.project.profile.name === freePlan.name) return next();

  Project.findOneAndUpdate(
    {
      _id: req.project._id,
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
    },
    { new: true }
  ).then(function(updatedProject) {
    if (updatedProject) {
      winston.info('Trial expired for project ' + req.project._id + ', downgraded to Free');
      req.project = updatedProject;
    }
    next();
  }).catch(function(err) {
    winston.error('Trial expiration middleware error', err);
    next();
  });
};
```

- [ ] **Step 2: Wire it into app.js**

In `app.js`, after the existing `require` statements near the top (around line 160), add:

```javascript
var trialExpiration = require('./middleware/trial-expiration');
```

Then find the project-scoped middleware chain (around line 563):

```javascript
app.use('/:projectid/', [projectIdSetter, projectSetter, IPFilter.projectIpFilter, IPFilter.projectIpFilterDeny, IPFilter.decodeJwt, IPFilter.projectBanUserFilter]);
```

Add `trialExpiration` after `projectSetter`:

```javascript
app.use('/:projectid/', [projectIdSetter, projectSetter, trialExpiration, IPFilter.projectIpFilter, IPFilter.projectIpFilterDeny, IPFilter.decodeJwt, IPFilter.projectBanUserFilter]);
```

- [ ] **Step 3: Test manually**

Set a project's trial to expired by backdating its creation:

```bash
docker exec mongo mongosh tiledesk --quiet --eval '
  db.projects.updateOne(
    {_id: ObjectId("69ec2d622f2b3a0015091fb8")},
    {$set: {
      createdAt: new Date("2026-03-01"),
      "profile.name": "Pro",
      "profile.type": "free",
      "profile.trialDays": 14,
      "profile.agents": 10
    }}
  )
'
```

Then make a request to that project:

```bash
ADMIN_TOKEN=$(curl -s -X POST http://localhost:3000/auth/signin \
  -H "Content-Type: application/json" \
  -d '{"email":"redacted@example.invalid","password":"adminadmin"}' | python -c "import sys,json; print(json.load(sys.stdin)['token'])")

curl -s "http://localhost:3000/69ec2d622f2b3a0015091fb8/departments" \
  -H "Authorization: $ADMIN_TOKEN" > /dev/null

docker exec mongo mongosh tiledesk --quiet --eval '
  var p = db.projects.findOne({_id: ObjectId("69ec2d622f2b3a0015091fb8")});
  printjson({plan: p.profile.name, agents: p.profile.agents})
'
```

Expected: `{ plan: "Free", agents: 1 }` — downgraded automatically.

- [ ] **Step 4: Commit**

```bash
cd C:\Users\enzo\tiledesk-server
git add middleware/trial-expiration.js app.js
git commit -m "feat: add trial expiration middleware

Lazily downgrades projects to Free plan when 14-day trial expires.
Uses atomic findOneAndUpdate to prevent race conditions."
```

---

### Task 3: Email Verification Gate on Billing (Server)

**Files:**
- Modify: `C:\Users\enzo\tiledesk-server\pubmodules\billing\index.js`

- [ ] **Step 1: Add the gate**

In `pubmodules/billing/index.js`, in the `POST /subscribe` handler, add the check right after the auth middleware runs and before any business logic. Find the line:

```javascript
      const { projectId, planKey } = req.body;
```

Add before it:

```javascript
      if (!req.user.emailverified) {
        return res.status(403).json({ error: 'email_not_verified', message: 'Verifique seu email antes de assinar um plano.' });
      }
```

- [ ] **Step 2: Test manually**

Create a user without email verification and try to subscribe:

```bash
# Signup (email not verified)
curl -s -X POST http://localhost:3000/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"redacted@example.invalid","password":"Test12345","firstname":"Test","lastname":"User"}'

# Login
TOKEN=$(curl -s -X POST http://localhost:3000/auth/signin \
  -H "Content-Type: application/json" \
  -d '{"email":"redacted@example.invalid","password":"Test12345"}' | python -c "import sys,json; print(json.load(sys.stdin)['token'])")

# Try to subscribe
curl -s -X POST http://localhost:3000/modules/payments/casepay/subscribe \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"69ec2d622f2b3a0015091fb8","planKey":"starter"}'
```

Expected: `{ "error": "email_not_verified", "message": "Verifique seu email antes de assinar um plano." }`

- [ ] **Step 3: Commit**

```bash
cd C:\Users\enzo\tiledesk-server
git add pubmodules/billing/index.js
git commit -m "feat: require email verification before subscribing

Returns 403 if user tries to create a CasePay mandate without
a verified email address."
```

---

### Task 4: Brand.json Customization (Dashboard)

**Files:**
- Modify: `C:\Users\enzo\tiledesk-dashboard\src\assets\brand\brand.json`

- [ ] **Step 1: Update brand.json**

Read the current `brand.json` to understand the full structure, then update these keys:

```json
{
  "BRAND_NAME": "ChatCase",
  "company_name": "ChatCase",
  "company_site_url": "https://chatcase.com.br",
  "contact_us_email": "redacted@example.invalid",
  "display_google_auth_btn": false,
  "privacy_policy_link_text": "Política de Privacidade",
  "terms_and_conditions_url": "https://chatcase.com.br/termos",
  "privacy_policy_url": "https://chatcase.com.br/privacidade",
  "signup_page": {
    "display_terms_and_conditions_link": true,
    "display_social_proof_container": false
  }
}
```

Only change these keys — leave all other keys at their defaults. Logo URLs can be updated later when assets are ready.

- [ ] **Step 2: Test in browser**

Open `http://localhost:8081/dashboard/#/signup` and verify the branding appears. Check that Google Auth button is hidden and social proof container is hidden.

- [ ] **Step 3: Commit**

```bash
cd C:\Users\enzo\tiledesk-dashboard
git add src/assets/brand/brand.json
git commit -m "feat: apply ChatCase branding to dashboard

Update company name, URLs, hide Google auth and social proof
on signup page."
```

---

### Task 5: Modify Signup Component (Dashboard)

**Files:**
- Modify: `C:\Users\enzo\tiledesk-dashboard\src\app\auth\signup\signup.component.ts`

- [ ] **Step 1: Change post-signup redirect**

In `signup.component.ts`, find the `autoSignin()` method (around line 667). After successful signin, instead of the existing conditional logic that calls `createNewProject()` or navigates to `/onboarding`, replace the entire post-signin success block with:

Find the block starting after `this.auth.signin(email, password, baseUrl, callback)` success callback where it checks `SKIP_WIZARD`, `areActivePay`, etc. (around lines 690-715). Replace the routing logic with:

```typescript
// After successful auto-signin, always go to verify-email-waiting
this.router.navigate(['/verify-email-waiting']);
```

Remove or comment out the `createNewProject()` call path — projects are now created in the workspace-name component.

- [ ] **Step 2: Add "email already registered" handling**

In the signup error handler (around line 620, where it checks `error.code === 11000`), ensure the error message includes a link to signin. The toast message should be:

```typescript
this.notify.showWidgetStyleUpdateNotification('Este email já está cadastrado.', 4, 'report_problem');
```

This already exists in the code — verify it works as expected.

- [ ] **Step 3: Test in browser**

1. Open `http://localhost:8081/dashboard/#/signup`
2. Fill in the form and submit
3. Verify redirect goes to `/verify-email-waiting` (will 404 for now — that's expected, we build it next)

- [ ] **Step 4: Commit**

```bash
cd C:\Users\enzo\tiledesk-dashboard
git add src/app/auth/signup/signup.component.ts
git commit -m "feat: redirect signup to verify-email-waiting

Remove automatic project creation from signup flow.
Projects are now created in the workspace-name step."
```

---

### Task 6: Verify Email Waiting Page (Dashboard)

**Files:**
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\verify-email-waiting\verify-email-waiting.module.ts`
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\verify-email-waiting\verify-email-waiting.component.ts`
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\verify-email-waiting\verify-email-waiting.component.html`
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\verify-email-waiting\verify-email-waiting.component.scss`
- Modify: `C:\Users\enzo\tiledesk-dashboard\src\app\app.routing.ts`

- [ ] **Step 1: Create the module**

Create `src/app/verify-email-waiting/verify-email-waiting.module.ts`:

```typescript
import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule, Routes } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { VerifyEmailWaitingComponent } from './verify-email-waiting.component';

const routes: Routes = [
  { path: '', component: VerifyEmailWaitingComponent }
];

@NgModule({
  declarations: [VerifyEmailWaitingComponent],
  imports: [
    CommonModule,
    FormsModule,
    TranslateModule,
    RouterModule.forChild(routes)
  ]
})
export class VerifyEmailWaitingModule { }
```

- [ ] **Step 2: Create the component**

Create `src/app/verify-email-waiting/verify-email-waiting.component.ts`:

```typescript
import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { UsersService } from '../services/users.service';

@Component({
  selector: 'appdashboard-verify-email-waiting',
  templateUrl: './verify-email-waiting.component.html',
  styleUrls: ['./verify-email-waiting.component.scss']
})
export class VerifyEmailWaitingComponent implements OnInit {

  userEmail: string = '';
  userId: string = '';
  verificationCode: string = '';
  errorMessage: string = '';
  successMessage: string = '';
  isLoading: boolean = false;
  isResending: boolean = false;

  constructor(
    private auth: AuthService,
    private usersService: UsersService,
    private router: Router
  ) { }

  ngOnInit() {
    const user = this.auth.user_bs.value;
    if (!user) {
      this.router.navigate(['/signup']);
      return;
    }
    if (user.emailverified) {
      this.router.navigate(['/workspace-name']);
      return;
    }
    this.userEmail = user.email;
    this.userId = user._id;
  }

  verifyCode() {
    if (!this.verificationCode || this.verificationCode.length < 4) {
      this.errorMessage = 'Digite o código enviado para seu email.';
      return;
    }
    this.isLoading = true;
    this.errorMessage = '';

    this.auth.emailVerify(this.userId, this.verificationCode).subscribe(
      (res: any) => {
        this.isLoading = false;
        const updatedUser = this.auth.user_bs.value;
        if (updatedUser) {
          updatedUser.emailverified = true;
          this.auth.publishUpdatedUser(updatedUser);
        }
        this.router.navigate(['/workspace-name']);
      },
      (err) => {
        this.isLoading = false;
        this.errorMessage = 'Código inválido. Verifique e tente novamente.';
      }
    );
  }

  resendEmail() {
    this.isResending = true;
    this.errorMessage = '';
    this.successMessage = '';

    this.usersService.resendVerifyEmail().subscribe(
      (res: any) => {
        this.isResending = false;
        this.successMessage = 'Email reenviado com sucesso!';
      },
      (err) => {
        this.isResending = false;
        this.errorMessage = 'Erro ao reenviar. Tente novamente.';
      }
    );
  }
}
```

- [ ] **Step 3: Create the template**

Create `src/app/verify-email-waiting/verify-email-waiting.component.html`:

```html
<div class="verify-email-container">
  <div class="verify-email-card">
    <div class="verify-email-icon">
      <i class="material-icons">mark_email_read</i>
    </div>

    <h2>Verifique seu email</h2>
    <p class="subtitle">
      Enviamos um código de verificação para
      <strong>{{ userEmail }}</strong>
    </p>

    <div class="code-input-group">
      <input
        type="text"
        [(ngModel)]="verificationCode"
        placeholder="Digite o código"
        maxlength="10"
        (keyup.enter)="verifyCode()"
        [disabled]="isLoading"
        autofocus
      />
      <button
        class="btn btn-primary verify-btn"
        (click)="verifyCode()"
        [disabled]="isLoading || !verificationCode"
      >
        <span *ngIf="!isLoading">Verificar</span>
        <span *ngIf="isLoading" class="spinner-border spinner-border-sm"></span>
      </button>
    </div>

    <div *ngIf="errorMessage" class="alert alert-danger">
      {{ errorMessage }}
    </div>

    <div *ngIf="successMessage" class="alert alert-success">
      {{ successMessage }}
    </div>

    <div class="resend-section">
      <p>Não recebeu o email?</p>
      <button
        class="btn btn-link"
        (click)="resendEmail()"
        [disabled]="isResending"
      >
        <span *ngIf="!isResending">Reenviar email</span>
        <span *ngIf="isResending">Enviando...</span>
      </button>
    </div>

    <div class="back-section">
      <a routerLink="/signup">Usou o email errado? Cadastre-se novamente</a>
    </div>
  </div>
</div>
```

- [ ] **Step 4: Create the styles**

Create `src/app/verify-email-waiting/verify-email-waiting.component.scss`:

```scss
.verify-email-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  background-color: #f5f5f5;
}

.verify-email-card {
  background: white;
  border-radius: 8px;
  padding: 48px;
  max-width: 460px;
  width: 100%;
  text-align: center;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
}

.verify-email-icon i {
  font-size: 64px;
  color: #4caf50;
  margin-bottom: 16px;
}

h2 {
  margin-bottom: 8px;
  font-size: 24px;
  color: #333;
}

.subtitle {
  color: #666;
  margin-bottom: 32px;
}

.code-input-group {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;

  input {
    flex: 1;
    padding: 12px 16px;
    border: 1px solid #ddd;
    border-radius: 6px;
    font-size: 18px;
    letter-spacing: 2px;
    text-align: center;

    &:focus {
      outline: none;
      border-color: #1e88e5;
    }
  }
}

.verify-btn {
  padding: 12px 24px;
  min-width: 120px;
}

.alert {
  margin-top: 12px;
  padding: 10px 16px;
  border-radius: 6px;
  font-size: 14px;
}

.resend-section {
  margin-top: 24px;

  p {
    color: #999;
    font-size: 14px;
    margin-bottom: 4px;
  }
}

.back-section {
  margin-top: 16px;

  a {
    color: #999;
    font-size: 13px;
    text-decoration: underline;
  }
}
```

- [ ] **Step 5: Add route to app.routing.ts**

In `src/app/app.routing.ts`, add after the existing signup route:

```typescript
{
  path: 'verify-email-waiting',
  loadChildren: () => import('app/verify-email-waiting/verify-email-waiting.module').then(m => m.VerifyEmailWaitingModule)
},
```

- [ ] **Step 6: Test in browser**

1. Sign up with a new account at `http://localhost:8081/dashboard/#/signup`
2. Should redirect to `/#/verify-email-waiting`
3. Page should show the email address and code input
4. Test "Reenviar email" button
5. Test "Cadastre-se novamente" link

- [ ] **Step 7: Commit**

```bash
cd C:\Users\enzo\tiledesk-dashboard
git add src/app/verify-email-waiting/ src/app/app.routing.ts
git commit -m "feat: add verify-email-waiting page

New page shown after signup where user enters verification code.
Guards redirect based on auth state and email verification status."
```

---

### Task 7: Workspace Name Page (Dashboard)

**Files:**
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\workspace-name\workspace-name.module.ts`
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\workspace-name\workspace-name.component.ts`
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\workspace-name\workspace-name.component.html`
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\workspace-name\workspace-name.component.scss`
- Modify: `C:\Users\enzo\tiledesk-dashboard\src\app\app.routing.ts`

- [ ] **Step 1: Create the module**

Create `src/app/workspace-name/workspace-name.module.ts`:

```typescript
import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule, Routes } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { WorkspaceNameComponent } from './workspace-name.component';

const routes: Routes = [
  { path: '', component: WorkspaceNameComponent }
];

@NgModule({
  declarations: [WorkspaceNameComponent],
  imports: [
    CommonModule,
    FormsModule,
    TranslateModule,
    RouterModule.forChild(routes)
  ]
})
export class WorkspaceNameModule { }
```

- [ ] **Step 2: Create the component**

Create `src/app/workspace-name/workspace-name.component.ts`:

```typescript
import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { ProjectService } from '../services/project.service';

@Component({
  selector: 'appdashboard-workspace-name',
  templateUrl: './workspace-name.component.html',
  styleUrls: ['./workspace-name.component.scss']
})
export class WorkspaceNameComponent implements OnInit {

  workspaceName: string = '';
  errorMessage: string = '';
  isLoading: boolean = false;

  constructor(
    private auth: AuthService,
    private projectService: ProjectService,
    private router: Router
  ) { }

  ngOnInit() {
    const user = this.auth.user_bs.value;
    if (!user) {
      this.router.navigate(['/signup']);
      return;
    }
    if (!user.emailverified) {
      this.router.navigate(['/verify-email-waiting']);
      return;
    }
  }

  createWorkspace() {
    const name = this.workspaceName.trim();
    if (!name || name.length < 2) {
      this.errorMessage = 'Digite o nome da sua empresa (mínimo 2 caracteres).';
      return;
    }

    this.isLoading = true;
    this.errorMessage = '';

    this.projectService.createProject(name, 'signup').subscribe(
      (project: any) => {
        this.isLoading = false;

        this.auth.projectSelected(project, true);
        this.projectService.newProjectCreated(true);

        this.router.navigate(['/project/' + project._id + '/home']);
      },
      (err) => {
        this.isLoading = false;
        this.errorMessage = 'Erro ao criar workspace. Tente novamente.';
      }
    );
  }
}
```

- [ ] **Step 3: Create the template**

Create `src/app/workspace-name/workspace-name.component.html`:

```html
<div class="workspace-container">
  <div class="workspace-card">
    <div class="workspace-icon">
      <i class="material-icons">business</i>
    </div>

    <h2>Crie seu workspace</h2>
    <p class="subtitle">Como se chama sua empresa?</p>

    <div class="name-input-group">
      <input
        type="text"
        [(ngModel)]="workspaceName"
        placeholder="Ex: Minha Empresa"
        maxlength="100"
        (keyup.enter)="createWorkspace()"
        [disabled]="isLoading"
        autofocus
      />
    </div>

    <div *ngIf="errorMessage" class="alert alert-danger">
      {{ errorMessage }}
    </div>

    <button
      class="btn btn-primary create-btn"
      (click)="createWorkspace()"
      [disabled]="isLoading || !workspaceName.trim()"
    >
      <span *ngIf="!isLoading">Criar workspace</span>
      <span *ngIf="isLoading" class="spinner-border spinner-border-sm"></span>
    </button>
  </div>
</div>
```

- [ ] **Step 4: Create the styles**

Create `src/app/workspace-name/workspace-name.component.scss`:

```scss
.workspace-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  background-color: #f5f5f5;
}

.workspace-card {
  background: white;
  border-radius: 8px;
  padding: 48px;
  max-width: 460px;
  width: 100%;
  text-align: center;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
}

.workspace-icon i {
  font-size: 64px;
  color: #1e88e5;
  margin-bottom: 16px;
}

h2 {
  margin-bottom: 8px;
  font-size: 24px;
  color: #333;
}

.subtitle {
  color: #666;
  margin-bottom: 32px;
}

.name-input-group {
  margin-bottom: 16px;

  input {
    width: 100%;
    padding: 14px 16px;
    border: 1px solid #ddd;
    border-radius: 6px;
    font-size: 16px;

    &:focus {
      outline: none;
      border-color: #1e88e5;
    }
  }
}

.create-btn {
  width: 100%;
  padding: 14px;
  font-size: 16px;
  margin-top: 8px;
}

.alert {
  margin-bottom: 12px;
  padding: 10px 16px;
  border-radius: 6px;
  font-size: 14px;
}
```

- [ ] **Step 5: Add route to app.routing.ts**

In `src/app/app.routing.ts`, add after the verify-email-waiting route:

```typescript
{
  path: 'workspace-name',
  loadChildren: () => import('app/workspace-name/workspace-name.module').then(m => m.WorkspaceNameModule),
  canActivate: [AuthGuard]
},
```

- [ ] **Step 6: Test in browser**

1. Navigate to `http://localhost:8081/dashboard/#/workspace-name`
2. Should show the workspace name form
3. Type a name and click "Criar workspace"
4. Should create the project and redirect to `/project/:id/home`

- [ ] **Step 7: Commit**

```bash
cd C:\Users\enzo\tiledesk-dashboard
git add src/app/workspace-name/ src/app/app.routing.ts
git commit -m "feat: add workspace-name page

New page where user names their workspace after email verification.
Creates project via projectService and redirects to dashboard."
```

---

### Task 8: Onboarding Checklist Component (Dashboard)

**Files:**
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\onboarding-checklist\onboarding-checklist.component.ts`
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\onboarding-checklist\onboarding-checklist.component.html`
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\onboarding-checklist\onboarding-checklist.component.scss`
- Modify: `C:\Users\enzo\tiledesk-dashboard\src\app\app.module.ts`
- Modify: `C:\Users\enzo\tiledesk-dashboard\src\app\app.component.html`

- [ ] **Step 1: Create the component**

Create `src/app/onboarding-checklist/onboarding-checklist.component.ts`:

```typescript
import { Component, OnInit, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { Subscription } from 'rxjs';

interface ChecklistItem {
  id: string;
  label: string;
  route: string;
  icon: string;
  completed: boolean;
}

@Component({
  selector: 'appdashboard-onboarding-checklist',
  templateUrl: './onboarding-checklist.component.html',
  styleUrls: ['./onboarding-checklist.component.scss']
})
export class OnboardingChecklistComponent implements OnInit, OnDestroy {

  items: ChecklistItem[] = [];
  isMinimized: boolean = false;
  isVisible: boolean = false;
  projectId: string = '';
  completedCount: number = 0;

  private subscription: Subscription;

  constructor(
    private auth: AuthService,
    private router: Router
  ) { }

  ngOnInit() {
    this.subscription = this.auth.project_bs.subscribe((project) => {
      if (!project) {
        this.isVisible = false;
        return;
      }

      this.projectId = project._id;
      var createdAt = new Date(project.createdAt);
      var thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      if (createdAt < thirtyDaysAgo) {
        this.isVisible = false;
        return;
      }

      this.loadState();
      this.isVisible = !this.isDismissed() && !this.allCompleted();
    });
  }

  ngOnDestroy() {
    if (this.subscription) {
      this.subscription.unsubscribe();
    }
  }

  private loadState() {
    var storageKey = 'checklist_' + this.projectId;
    var saved = localStorage.getItem(storageKey);
    var completedIds: string[] = saved ? JSON.parse(saved).completed || [] : [];

    this.items = [
      { id: 'whatsapp', label: 'Conectar WhatsApp', route: '/project/' + this.projectId + '/integrations?name=whatsapp', icon: 'chat', completed: completedIds.indexOf('whatsapp') > -1 },
      { id: 'flow', label: 'Criar primeiro fluxo', route: '/project/' + this.projectId + '/cds/chatbot-design-studio', icon: 'account_tree', completed: completedIds.indexOf('flow') > -1 },
      { id: 'welcome', label: 'Personalizar boas-vindas', route: '/project/' + this.projectId + '/widget/set-up', icon: 'waving_hand', completed: completedIds.indexOf('welcome') > -1 },
      { id: 'hours', label: 'Definir horário de atendimento', route: '/project/' + this.projectId + '/hours', icon: 'schedule', completed: completedIds.indexOf('hours') > -1 },
      { id: 'agent', label: 'Convidar um agente', route: '/project/' + this.projectId + '/project-settings/teammates', icon: 'person_add', completed: completedIds.indexOf('agent') > -1 }
    ];

    this.completedCount = this.items.filter(function(i) { return i.completed; }).length;
  }

  private saveState() {
    var storageKey = 'checklist_' + this.projectId;
    var completedIds = this.items.filter(function(i) { return i.completed; }).map(function(i) { return i.id; });
    localStorage.setItem(storageKey, JSON.stringify({ completed: completedIds }));
  }

  toggleItem(item: ChecklistItem) {
    item.completed = !item.completed;
    this.completedCount = this.items.filter(function(i) { return i.completed; }).length;
    this.saveState();

    if (this.allCompleted()) {
      this.isVisible = false;
    }
  }

  navigateTo(item: ChecklistItem) {
    this.router.navigateByUrl(item.route);
  }

  toggleMinimize() {
    this.isMinimized = !this.isMinimized;
  }

  dismiss() {
    var storageKey = 'checklist_dismissed_' + this.projectId;
    localStorage.setItem(storageKey, 'true');
    this.isVisible = false;
  }

  private isDismissed(): boolean {
    var storageKey = 'checklist_dismissed_' + this.projectId;
    return localStorage.getItem(storageKey) === 'true';
  }

  private allCompleted(): boolean {
    return this.items.length > 0 && this.items.every(function(i) { return i.completed; });
  }
}
```

- [ ] **Step 2: Create the template**

Create `src/app/onboarding-checklist/onboarding-checklist.component.html`:

```html
<div class="checklist-overlay" *ngIf="isVisible" [class.minimized]="isMinimized">
  <div class="checklist-header" (click)="toggleMinimize()">
    <span class="checklist-title">
      <i class="material-icons">rocket_launch</i>
      Primeiros passos
    </span>
    <span class="checklist-progress">{{ completedCount }}/{{ items.length }}</span>
    <div class="checklist-actions">
      <button class="btn-icon" (click)="toggleMinimize(); $event.stopPropagation()">
        <i class="material-icons">{{ isMinimized ? 'expand_less' : 'expand_more' }}</i>
      </button>
      <button class="btn-icon" (click)="dismiss(); $event.stopPropagation()">
        <i class="material-icons">close</i>
      </button>
    </div>
  </div>

  <div class="checklist-body" *ngIf="!isMinimized">
    <div class="progress-bar-container">
      <div class="progress-bar-fill" [style.width.%]="(completedCount / items.length) * 100"></div>
    </div>

    <div
      *ngFor="let item of items"
      class="checklist-item"
      [class.completed]="item.completed"
    >
      <button class="check-btn" (click)="toggleItem(item)">
        <i class="material-icons">{{ item.completed ? 'check_circle' : 'radio_button_unchecked' }}</i>
      </button>
      <span class="item-label" (click)="navigateTo(item)">
        <i class="material-icons item-icon">{{ item.icon }}</i>
        {{ item.label }}
      </span>
    </div>
  </div>
</div>
```

- [ ] **Step 3: Create the styles**

Create `src/app/onboarding-checklist/onboarding-checklist.component.scss`:

```scss
.checklist-overlay {
  position: fixed;
  bottom: 24px;
  right: 24px;
  width: 320px;
  background: white;
  border-radius: 12px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.15);
  z-index: 9999;
  overflow: hidden;
  transition: all 0.2s ease;

  &.minimized {
    width: 280px;
  }
}

.checklist-header {
  display: flex;
  align-items: center;
  padding: 14px 16px;
  background: #1e88e5;
  color: white;
  cursor: pointer;
  user-select: none;
}

.checklist-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 14px;
  flex: 1;

  i {
    font-size: 20px;
  }
}

.checklist-progress {
  font-size: 13px;
  opacity: 0.9;
  margin-right: 8px;
}

.checklist-actions {
  display: flex;
  gap: 2px;
}

.btn-icon {
  background: none;
  border: none;
  color: white;
  cursor: pointer;
  padding: 2px;
  border-radius: 4px;
  display: flex;
  align-items: center;

  &:hover {
    background: rgba(255, 255, 255, 0.2);
  }

  i {
    font-size: 20px;
  }
}

.checklist-body {
  padding: 12px 0;
}

.progress-bar-container {
  height: 3px;
  background: #e0e0e0;
  margin: 0 16px 12px;
  border-radius: 2px;
}

.progress-bar-fill {
  height: 100%;
  background: #4caf50;
  border-radius: 2px;
  transition: width 0.3s ease;
}

.checklist-item {
  display: flex;
  align-items: center;
  padding: 8px 16px;
  cursor: pointer;
  transition: background 0.15s;

  &:hover {
    background: #f5f5f5;
  }

  &.completed .item-label {
    text-decoration: line-through;
    color: #999;
  }
}

.check-btn {
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  margin-right: 10px;
  display: flex;

  i {
    font-size: 22px;
    color: #ccc;
  }

  .completed & i {
    color: #4caf50;
  }
}

.item-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: #333;
  flex: 1;
}

.item-icon {
  font-size: 18px;
  color: #888;
}
```

- [ ] **Step 4: Declare in app.module.ts**

In `src/app/app.module.ts`, add the import and declaration:

Add to imports section:
```typescript
import { OnboardingChecklistComponent } from './onboarding-checklist/onboarding-checklist.component';
```

Add `OnboardingChecklistComponent` to the `declarations` array of `@NgModule`.

- [ ] **Step 5: Inject in app.component.html**

In `src/app/app.component.html`, add at the end of the file (before the closing tag):

```html
<appdashboard-onboarding-checklist *ngIf="!LOGIN_PAGE && user"></appdashboard-onboarding-checklist>
```

The `LOGIN_PAGE` variable is already tracked in `app.component.ts` (line 62) and is `true` on signup, login, onboarding pages. `user` is the authenticated user object. This ensures the checklist only shows inside the dashboard, not on auth pages.

- [ ] **Step 6: Test in browser**

1. Log in and navigate to any project page
2. Checklist should appear in the bottom-right corner
3. Test clicking items (should navigate to correct page)
4. Test checking/unchecking items
5. Test minimize and dismiss
6. Refresh page — state should persist
7. Dismiss and refresh — should stay hidden

- [ ] **Step 7: Commit**

```bash
cd C:\Users\enzo\tiledesk-dashboard
git add src/app/onboarding-checklist/ src/app/app.module.ts src/app/app.component.html
git commit -m "feat: add floating onboarding checklist

5-item guided checklist overlay for new projects. Persisted in
localStorage, auto-hidden after 30 days or completion."
```

---

### Task 9: Server-Side Pro Trial Profile on Project Creation (Server)

**Files:**
- Modify: `C:\Users\enzo\tiledesk-server\routes\project.js`

- [ ] **Step 1: Find the project creation route**

In `routes/project.js`, locate the `POST /` handler that creates new projects. Find where `new Project(...)` is called and the profile defaults are set.

- [ ] **Step 2: Add Pro trial profile for signup-created projects**

After the project is created but before saving, check if the source is 'signup' and apply the Pro trial profile:

```javascript
var { getPlan } = require('../pubmodules/billing/plans');

// Inside the POST / handler, after creating the project object but before save:
if (req.body.source === 'signup') {
  var proPlan = getPlan('pro');
  project.profile = {
    name: proPlan.name,
    type: 'free',
    trialDays: 14,
    agents: proPlan.agents,
    quotes: proPlan.quotes,
    customization: proPlan.customization
  };
}
```

The `type: 'free'` is intentional — it means "not paying yet" which enables the trial logic. The features are Pro-level so the user gets 14 days of full access.

- [ ] **Step 3: Test manually**

```bash
ADMIN_TOKEN=$(curl -s -X POST http://localhost:3000/auth/signin \
  -H "Content-Type: application/json" \
  -d '{"email":"redacted@example.invalid","password":"adminadmin"}' | python -c "import sys,json; print(json.load(sys.stdin)['token'])")

curl -s -X POST http://localhost:3000/projects \
  -H "Authorization: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Trial Test Project","source":"signup"}' | python -c "
import sys, json
p = json.load(sys.stdin)
prof = p.get('profile', {})
print(f'Plan: {prof.get(\"name\")}')
print(f'Type: {prof.get(\"type\")}')
print(f'Agents: {prof.get(\"agents\")}')
print(f'WhatsApp: {prof.get(\"customization\", {}).get(\"whatsapp\")}')
"
```

Expected: `Plan: Pro`, `Type: free`, `Agents: 10`, `WhatsApp: True`

- [ ] **Step 4: Commit**

```bash
cd C:\Users\enzo\tiledesk-server
git add routes/project.js
git commit -m "feat: create projects with Pro trial profile on signup

Projects created with source=signup get Pro plan features for
14 days. After trial expiration, middleware downgrades to Free."
```

---

### Task 10: Final Integration Test

- [ ] **Step 1: Rebuild both containers**

```bash
cd C:\Users\enzo\tiledesk
docker compose up -d --build server
# Dashboard rebuild if using local build, otherwise restart:
docker compose restart dashboard
```

- [ ] **Step 2: Full flow test**

1. Open `http://localhost:8081/dashboard/#/signup`
2. Sign up with a new email
3. Should redirect to `/verify-email-waiting`
4. Check server logs for verification code (since SMTP may not be configured):
   ```bash
   docker logs server 2>&1 | grep -i "verify\|code" | tail -5
   ```
5. Enter the code → should redirect to `/workspace-name`
6. Enter workspace name → should redirect to project home
7. Checklist should appear in bottom-right
8. Verify project has Pro trial profile in MongoDB

- [ ] **Step 3: Push all changes**

```bash
cd C:\Users\enzo\tiledesk-server && git push origin master
cd C:\Users\enzo\tiledesk-dashboard && git push origin master
```
