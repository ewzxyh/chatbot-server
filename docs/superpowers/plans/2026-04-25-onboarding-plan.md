# Onboarding Flow Implementation Plan (v2 — pós-auditoria)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Public signup → email verification → workspace creation → dashboard with guided checklist for ChatCase SaaS.

**Architecture:** Modify existing Tiledesk signup flow (Angular dashboard + Node.js server). Server gets 5 changes (index fix, project service profile override, route source plumbing, trial middleware, email gate with DB fresh check). Dashboard gets 7 changes (project service body, brand.json nested, signup redirect, verify-email-waiting, workspace-name, app.component user prop, onboarding checklist).

**Tech Stack:** Angular 14 (dashboard), Node.js/Express/Mongoose (server), MongoDB

**Spec:** `docs/superpowers/specs/2026-04-25-onboarding-design.md`

**Order matters:** Server-side changes go first (Tasks 1-5). Dashboard components are built before being referenced (Tasks 6-9 before Task 10). Otherwise intermediate testing fails with 404.

---

## File Map

### Server (C:\Users\enzo\tiledesk-server)

| File | Action | Purpose |
|---|---|---|
| `app.js` | Modify | Add phone_1 index fix on boot |
| `services/projectService.js` | Modify | Accept `profileOverride` arg in create() |
| `routes/project.js` | Modify | Pass `req.body.source` to projectService.create() with Pro trial profile |
| `middleware/trial-expiration.js` | Create | Lazy downgrade when trial expires; skips unauthenticated requests |
| `app.js` | Modify | Wire trial-expiration middleware to project-scoped chain |
| `pubmodules/billing/index.js` | Modify | Add emailverified gate on /subscribe (queries DB fresh) |

### Dashboard (C:\Users\enzo\tiledesk-dashboard)

| File | Action | Purpose |
|---|---|---|
| `src/app/services/project.service.ts` | Modify | Send `source` field in create body |
| `src/assets/brand/brand.json` | Modify | ChatCase branding (nested keys) |
| `src/app/verify-email-waiting/*` | Create | Code input + resend + wait |
| `src/app/workspace-name/*` | Create | Name input + create project |
| `src/app/app.component.ts` | Modify | Add `user` public property |
| `src/app/auth/signup/signup.component.ts` | Modify | Redirect to /verify-email-waiting (preserve invitation/stored-route flows) |
| `src/app/onboarding-checklist/*` | Create | Floating overlay logic |
| `src/app/app.module.ts` | Modify | Declare checklist component |
| `src/app/app.component.html` | Modify | Inject checklist overlay |
| `src/app/app.routing.ts` | Modify | Add new routes |

---

### Task 1: Fix phone_1 MongoDB Index (Server)

**Files:**
- Modify: `C:\Users\enzo\tiledesk-server\app.js`

- [ ] **Step 1: Locate mongoose connection callback**

In `app.js`, find where `mongoose.connect(databaseUri, ...)` is called (around line 240-250). The fix runs after connection succeeds.

- [ ] **Step 2: Add the index fix**

After the mongoose connection succeeds, add:

```javascript
// Fix phone_1 unique index — allow multiple users without phone (sparse)
mongoose.connection.once('open', async function() {
  try {
    var usersCollection = mongoose.connection.db.collection('users');
    var indexes = await usersCollection.indexes();
    var phoneIndex = indexes.find(function(idx) { return idx.name === 'phone_1'; });

    if (phoneIndex && !phoneIndex.sparse) {
      await usersCollection.dropIndex('phone_1');
      await usersCollection.createIndex({ phone: 1 }, { unique: true, sparse: true });
      winston.info('phone_1 index recreated as sparse');
    } else if (!phoneIndex) {
      await usersCollection.createIndex({ phone: 1 }, { unique: true, sparse: true });
      winston.info('phone_1 sparse index created');
    } else {
      winston.debug('phone_1 already sparse, skipping fix');
    }
  } catch (err) {
    winston.warn('phone_1 index fix error: ' + err.message);
  }
});
```

The `listIndexes()` check makes it idempotent and safe across restarts and concurrent boots.

- [ ] **Step 3: Test manually**

```bash
cd C:\Users\enzo\tiledesk
docker compose up -d --build server
```

Wait for healthy. Verify in logs:

```bash
docker logs server 2>&1 | grep "phone_1"
```

Expected: `phone_1 index recreated as sparse` (first boot) or `phone_1 already sparse, skipping fix` (subsequent boots).

Test by signing up two users without phone:

```bash
curl -s -X POST http://localhost:3000/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"redacted@example.invalid","password":"Test12345","firstname":"A","lastname":"B"}'

curl -s -X POST http://localhost:3000/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"redacted@example.invalid","password":"Test12345","firstname":"C","lastname":"D"}'
```

Both should return `"success": true`.

- [ ] **Step 4: Commit**

```bash
cd C:\Users\enzo\tiledesk-server
git add app.js
git commit -m "fix: recreate phone_1 index as sparse on boot

Idempotent fix that checks listIndexes before recreating.
Resolves bug where second user signup fails on null phone."
```

---

### Task 2: Server — Accept Profile Override in projectService

**Files:**
- Modify: `C:\Users\enzo\tiledesk-server\services\projectService.js`

- [ ] **Step 1: Extend createAndReturnProjectAndProjectUser signature**

In `services/projectService.js`, modify `createAndReturnProjectAndProjectUser(name, createdBy, settings)` to accept a 4th `profileOverride` parameter and apply it to the new Project before save.

Replace the existing function (lines 15-65) with:

```javascript
  createAndReturnProjectAndProjectUser(name, createdBy, settings, profileOverride) {
    return new Promise(function (resolve, reject) {

      var projectData = {
        name: name,
        activeOperatingHours: false,
        settings: settings,
        createdBy: createdBy,
        updatedBy: createdBy
      };

      if (profileOverride) {
        projectData.profile = profileOverride;
      }

      var newProject = new Project(projectData);

      return newProject.save(function (err, savedProject) {
        if (err) {
          winston.error('Error saving the project ', err)
          return reject({ success: false, msg: 'Error saving project.' });
        }

        var newProject_user = new Project_user({
          id_project: savedProject._id,
          id_user: createdBy,
          role: RoleConstants.OWNER,
          roleType: RoleConstants.TYPE_AGENTS,
          user_available: true,
          createdBy: createdBy,
          updatedBy: createdBy
        });

        return newProject_user.save(function (err, savedProject_user) {
          if (err) {
            winston.error('Error saving the projet_user ', err)
            return reject(err);
          }

          return departmentService.createDefault(savedProject._id, createdBy).then(function (createdDepartment) {
            winston.verbose("Project created", savedProject.toObject());
            projectEvent.emit('project.create', savedProject);
            return resolve({ project: savedProject, project_user: savedProject_user });
          });
        });
      });
    });
  }
```

- [ ] **Step 2: Update create() wrapper**

Modify the `create()` method (line 67-76) to pass through the new arg:

```javascript
  create(name, createdBy, settings, profileOverride) {
    var that = this;
    return new Promise(function (resolve, reject) {
      return that.createAndReturnProjectAndProjectUser(name, createdBy, settings, profileOverride).then(function (projectAndProjectUser) {
        return resolve(projectAndProjectUser.project);
      }).catch(function (err) {
        return reject(err);
      });
    });
  }
```

- [ ] **Step 3: Verify no other callers break**

```bash
grep -rn "projectService.create\b\|projectService.createAndReturn" "C:\Users\enzo\tiledesk-server" --include="*.js"
```

All existing callers use 1-3 args; the new 4th arg is optional and defaults to undefined (no profile override). Backward compatible.

- [ ] **Step 4: Commit**

```bash
cd C:\Users\enzo\tiledesk-server
git add services/projectService.js
git commit -m "feat: projectService.create accepts profile override

Allows callers to specify profile (plan, quotas, customization)
at project creation time. Backward compatible — existing callers
omit the new arg and default behavior is unchanged."
```

---

### Task 3: Server — Apply Pro Trial Profile on Signup

**Files:**
- Modify: `C:\Users\enzo\tiledesk-server\routes\project.js`

- [ ] **Step 1: Import getPlan helper**

In `routes/project.js`, add near the top imports (around line 27):

```javascript
var { getPlan } = require('../pubmodules/billing/plans');
```

- [ ] **Step 2: Pass profile override when source is signup**

Replace the existing `POST /` handler (lines 46-53):

```javascript
router.post('/', [passport.authenticate(['basic', 'jwt'], { session: false }), validtoken], async (req, res) => {

  var profileOverride;
  if (req.body.source === 'signup') {
    var proPlan = getPlan('pro');
    profileOverride = {
      name: proPlan.name,
      type: 'free',
      trialDays: 14,
      agents: proPlan.agents,
      quotes: proPlan.quotes,
      customization: proPlan.customization
    };
  }

  return projectService.create(req.body.name, req.user.id, undefined, profileOverride).then(function (savedProject) {
    res.json(savedProject);
  }).catch(function (err) {
    winston.error('Error creating project: ', err);
    res.status(500).json({ success: false, error: 'Failed to create project' });
  });
});
```

- [ ] **Step 3: Test manually**

After rebuild, test:

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
print('Plan:', prof.get('name'))
print('Type:', prof.get('type'))
print('Agents:', prof.get('agents'))
print('TrialDays:', prof.get('trialDays'))
print('WhatsApp:', prof.get('customization', {}).get('whatsapp'))
"
```

Expected: `Plan: Pro`, `Type: free`, `Agents: 10`, `TrialDays: 14`, `WhatsApp: True`.

Test that backward compat works (project without `source`):

```bash
curl -s -X POST http://localhost:3000/projects \
  -H "Authorization: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Default Test Project"}' | python -c "
import sys, json
p = json.load(sys.stdin)
print('Plan:', p.get('profile', {}).get('name'))
"
```

Expected: `Plan: Sandbox` (default profile).

- [ ] **Step 4: Commit**

```bash
cd C:\Users\enzo\tiledesk-server
git add routes/project.js
git commit -m "feat: apply Pro trial profile when project source is signup

Projects created with source=signup get Pro plan features for
14 days. Other creation paths unchanged."
```

---

### Task 4: Server — Trial Expiration Middleware

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
  if (!req.user) return next(); // skip webhooks/unauthenticated routes
  if (req.project.profile.type === 'payment') return next();
  if (!req.project.trialExpired) return next();

  var freePlan = getPlan('free');

  if (req.project.profile.name === freePlan.name) return next();

  Project.findOneAndUpdate(
    {
      _id: req.project._id,
      'profile.type': { $ne: 'payment' }
    },
    {
      $set: {
        'profile.name': freePlan.name,
        'profile.type': freePlan.type,
        'profile.agents': freePlan.agents,
        'profile.quotes': freePlan.quotes,
        'profile.customization': freePlan.customization
      }
    },
    { new: true }
  ).then(function (updatedProject) {
    if (updatedProject) {
      winston.info('Trial expired for project ' + req.project._id + ', downgraded to Free');
      req.project = updatedProject;
    }
    return next();
  }).catch(function (err) {
    winston.error('Trial expiration middleware error', err);
    return next();
  });
};
```

The `!req.user` check skips webhooks (Telegram, Facebook, etc.) and other unauthenticated `/:projectid/*` routes. Trial enforcement only triggers when a real user makes a request.

- [ ] **Step 2: Sanity check on TRIAL_MODE_ENABLED**

In the same file, add at module load:

```javascript
if (process.env.TRIAL_MODE_ENABLED !== 'true') {
  winston.warn('TRIAL_MODE_ENABLED is not "true" — trial expiration middleware will never trigger because trialExpired virtual always returns false.');
}
```

This warns at boot if the env is misconfigured.

- [ ] **Step 3: Wire it into app.js**

In `app.js`, after the existing `require` statements near the top (around line 160):

```javascript
var trialExpiration = require('./middleware/trial-expiration');
```

Then find the project-scoped middleware chain around line 563:

```javascript
app.use('/:projectid/', [projectIdSetter, projectSetter, IPFilter.projectIpFilter, IPFilter.projectIpFilterDeny, IPFilter.decodeJwt, IPFilter.projectBanUserFilter]);
```

Add `trialExpiration` after `IPFilter.decodeJwt` (so `req.user` may be set by then via JWT decoding):

```javascript
app.use('/:projectid/', [projectIdSetter, projectSetter, IPFilter.projectIpFilter, IPFilter.projectIpFilterDeny, IPFilter.decodeJwt, trialExpiration, IPFilter.projectBanUserFilter]);
```

- [ ] **Step 4: Test manually**

Backdate a project's creation to simulate expired trial:

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

Make any authenticated request to that project:

```bash
ADMIN_TOKEN=$(curl -s -X POST http://localhost:3000/auth/signin \
  -H "Content-Type: application/json" \
  -d '{"email":"redacted@example.invalid","password":"adminadmin"}' | python -c "import sys,json; print(json.load(sys.stdin)['token'])")

curl -s "http://localhost:3000/69ec2d622f2b3a0015091fb8/departments" \
  -H "Authorization: $ADMIN_TOKEN" > /dev/null
```

Verify downgrade:

```bash
docker exec mongo mongosh tiledesk --quiet --eval '
  var p = db.projects.findOne({_id: ObjectId("69ec2d622f2b3a0015091fb8")});
  printjson({plan: p.profile.name, agents: p.profile.agents})
'
```

Expected: `{ plan: "Free", agents: 1 }`.

Check logs:

```bash
docker logs server 2>&1 | grep "Trial expired" | tail -3
```

- [ ] **Step 5: Commit**

```bash
cd C:\Users\enzo\tiledesk-server
git add middleware/trial-expiration.js app.js
git commit -m "feat: trial expiration middleware with safe defaults

Lazily downgrades projects to Free when trial expires.
Skips webhooks/unauthenticated requests via req.user check.
Warns at boot if TRIAL_MODE_ENABLED is misconfigured."
```

---

### Task 5: Server — Email Verification Gate (DB-fresh)

**Files:**
- Modify: `C:\Users\enzo\tiledesk-server\pubmodules\billing\index.js`

- [ ] **Step 1: Import User model**

In `pubmodules/billing/index.js`, add near the existing requires:

```javascript
var User = require('../../models/user');
```

- [ ] **Step 2: Add DB-fresh email verification gate in /subscribe**

In the `POST /subscribe` handler, before reading `req.body`, add:

```javascript
      var userId = req.user._id || req.user.id;
      var freshUser = await User.findById(userId).select('emailverified').lean();
      if (!freshUser || !freshUser.emailverified) {
        return res.status(403).json({
          error: 'email_not_verified',
          message: 'Verifique seu email antes de assinar um plano.'
        });
      }
```

The DB-fresh query bypasses JWT staleness — `req.user.emailverified` is frozen at login time and would still say `false` even after the user verified email in this session.

- [ ] **Step 3: Test manually**

Create unverified user, try to subscribe:

```bash
curl -s -X POST http://localhost:3000/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"redacted@example.invalid","password":"Test12345","firstname":"Test","lastname":"User"}'

TOKEN=$(curl -s -X POST http://localhost:3000/auth/signin \
  -H "Content-Type: application/json" \
  -d '{"email":"redacted@example.invalid","password":"Test12345"}' | python -c "import sys,json; print(json.load(sys.stdin)['token'])")

curl -s -X POST http://localhost:3000/modules/payments/casepay/subscribe \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"69ec25422f2b3a0015091b7a","planKey":"starter"}'
```

Expected: `{ "error": "email_not_verified", "message": "Verifique seu email antes de assinar um plano." }`

Now manually verify in DB and try again — should NOT need re-login:

```bash
docker exec mongo mongosh tiledesk --quiet --eval '
  db.users.updateOne({email: "redacted@example.invalid"}, {$set: {emailverified: true}})
'

# Same token, retry — should now bypass the gate
curl -s -X POST http://localhost:3000/modules/payments/casepay/subscribe \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"69ec25422f2b3a0015091b7a","planKey":"starter"}'
```

Expected: error from later validation (e.g., user not project owner), NOT the email_not_verified error.

- [ ] **Step 4: Commit**

```bash
cd C:\Users\enzo\tiledesk-server
git add pubmodules/billing/index.js
git commit -m "feat: email verification gate on /subscribe

Queries User from DB to bypass JWT staleness. Users who verify
email in their current session can subscribe immediately without
re-signing in to refresh the token."
```

---

### Task 6: Dashboard — project.service.ts sends source

**Files:**
- Modify: `C:\Users\enzo\tiledesk-dashboard\src\app\services\project.service.ts`

- [ ] **Step 1: Update createProject body**

In `src/app/services/project.service.ts`, modify the `createProject` method (line 207-235). Replace the body construction:

```typescript
    const body: any = { 'name': name };
    if (calledBy) {
      body.source = calledBy;
    }
```

Full updated method block (replacing line 220):

```typescript
  public createProject(name: string, calledBy) {
    this.logger.log('[PROJECT-SERV] CREATE PROJECT calledBy ', calledBy);
    const httpOptions = {
      headers: new HttpHeaders({
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': this.TOKEN
      })
    };

    const url = this.PROJECTS_URL;
    this.logger.log('[PROJECT-SERV] CREATE PROJECT POST REQUEST - URL ', url);

    const body: any = { 'name': name };
    if (calledBy) {
      body.source = calledBy;
    }
    this.logger.log('[PROJECT-SERV] CREATE PROJECT POST REQUEST - BODY ', body);

    const create$ = this._httpclient
      .post(url, JSON.stringify(body), httpOptions)
      .pipe(
        tap(() => {
          this.cacheService.clearAllProjectsCache();
          this.logger.log('[PROJECT-SERV] - CREATE PROJECT - Cleared all projects cache');
        })
      );

    return create$;
  }
```

- [ ] **Step 2: Commit**

```bash
cd C:\Users\enzo\tiledesk-dashboard
git add src/app/services/project.service.ts
git commit -m "feat: send source field to server on createProject

Server uses source=signup to apply Pro trial profile."
```

---

### Task 7: Dashboard — brand.json (nested keys)

**Files:**
- Modify: `C:\Users\enzo\tiledesk-dashboard\src\assets\brand\brand.json`

- [ ] **Step 1: Update nested keys for ChatCase branding**

Open `src/assets/brand/brand.json`. The file has top-level sections `DASHBOARD`, `WIDGET`, `CHAT`, `CDS`, `COMMON`. Modify only specific nested keys — leave structure intact.

In the `DASHBOARD` section, change:
```json
    "META_TITLE": "ChatCase",
    "privacy_policy_link_text": "Política de Privacidade",
    "privacy_policy_url": "https://chatcase.com.br/privacidade",
    "terms_and_conditions_url": "https://chatcase.com.br/termos",
    "contact_us_email": "redacted@example.invalid",
    "display_google_auth_btn": false,
    "display_forgot_pwd": true,
```

In the `DASHBOARD.signup_page` section (existing), confirm:
```json
    "signup_page": {
      "display_terms_and_conditions_link": true,
      "display_social_proof_container": false
    },
```

In the `COMMON` section, change:
```json
    "COMPANY_NAME": "ChatCase",
    "BRAND_NAME": "ChatCase",
    "COMPANY_SITE_NAME": "chatcase.com.br",
    "COMPANY_SITE_URL": "https://chatcase.com.br",
    "CONTACT_US_EMAIL": "redacted@example.invalid",
    "CONTACT_SALES_EMAIL": "redacted@example.invalid"
```

In the `CDS` section, change:
```json
    "META_TITLE": "ChatCase Design Studio"
```

**DO NOT** add new top-level keys. **DO NOT** rename the `DASHBOARD`/`WIDGET`/`COMMON` sections. Logo URLs (`COMPANY_LOGO`, `BASE_LOGO`, `LOGO_CHAT`) can be updated later when assets are ready — leave existing values for now.

- [ ] **Step 2: Test in browser**

Refresh dashboard, verify:
1. `http://localhost:8081/dashboard/#/signup` — page title shows ChatCase, Google Auth button hidden, forgot password link visible
2. Existing dashboard pages still load (no broken brand references)

- [ ] **Step 3: Commit**

```bash
cd C:\Users\enzo\tiledesk-dashboard
git add src/assets/brand/brand.json
git commit -m "feat: apply ChatCase branding via nested brand.json keys

Update only DASHBOARD, COMMON, CDS section values. Preserve
existing structure to avoid breaking any consumer of brand keys."
```

---

### Task 8: Dashboard — verify-email-waiting Component

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

- [ ] **Step 2: Create the component (subscribes to user_bs to avoid race)**

Create `src/app/verify-email-waiting/verify-email-waiting.component.ts`:

```typescript
import { Component, OnInit, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { AuthService } from '../core/auth.service';
import { UsersService } from '../services/users.service';

@Component({
  selector: 'appdashboard-verify-email-waiting',
  templateUrl: './verify-email-waiting.component.html',
  styleUrls: ['./verify-email-waiting.component.scss']
})
export class VerifyEmailWaitingComponent implements OnInit, OnDestroy {

  userEmail: string = '';
  userId: string = '';
  verificationCode: string = '';
  errorMessage: string = '';
  successMessage: string = '';
  isLoading: boolean = false;
  isResending: boolean = false;

  private userSub: Subscription;

  constructor(
    private auth: AuthService,
    private usersService: UsersService,
    private router: Router
  ) { }

  ngOnInit() {
    // Subscribe (not .value) to handle the async signin race condition
    this.userSub = this.auth.user_bs.subscribe((user) => {
      if (!user) {
        // Wait for user to populate; if it stays null, redirect after a tick
        setTimeout(() => {
          if (!this.auth.user_bs.value) this.router.navigate(['/signup']);
        }, 1000);
        return;
      }
      if (user.emailverified) {
        this.router.navigate(['/workspace-name']);
        return;
      }
      this.userEmail = user.email;
      this.userId = user._id;
    });
  }

  ngOnDestroy() {
    if (this.userSub) this.userSub.unsubscribe();
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
        const errorCode = err && err.error && err.error.error_code;

        // Map server error codes (auth.js error_code constants)
        switch (errorCode) {
          case 10005:
            this.errorMessage = 'O código expirou ou é inválido. Clique em "Reenviar email".';
            break;
          case 10006:
            this.errorMessage = 'Este código pertence a outra conta.';
            break;
          case 10004:
            this.errorMessage = 'Código não fornecido.';
            break;
          default:
            this.errorMessage = 'Código inválido. Verifique e tente novamente.';
        }
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

    <div *ngIf="errorMessage" class="alert alert-danger">{{ errorMessage }}</div>
    <div *ngIf="successMessage" class="alert alert-success">{{ successMessage }}</div>

    <div class="resend-section">
      <p>Não recebeu o email?</p>
      <button class="btn btn-link" (click)="resendEmail()" [disabled]="isResending">
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

h2 { margin-bottom: 8px; font-size: 24px; color: #333; }
.subtitle { color: #666; margin-bottom: 32px; }

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
    &:focus { outline: none; border-color: #1e88e5; }
  }
}

.verify-btn { padding: 12px 24px; min-width: 120px; }

.alert {
  margin-top: 12px;
  padding: 10px 16px;
  border-radius: 6px;
  font-size: 14px;
}

.resend-section {
  margin-top: 24px;
  p { color: #999; font-size: 14px; margin-bottom: 4px; }
}

.back-section {
  margin-top: 16px;
  a { color: #999; font-size: 13px; text-decoration: underline; }
}
```

- [ ] **Step 5: Add route**

In `src/app/app.routing.ts`, add after the existing `signup` route:

```typescript
{
  path: 'verify-email-waiting',
  loadChildren: () => import('app/verify-email-waiting/verify-email-waiting.module').then(m => m.VerifyEmailWaitingModule)
},
```

- [ ] **Step 6: Test directly**

Sign in as a user that's not verified, then manually navigate to `http://localhost:8081/dashboard/#/verify-email-waiting`. Should show the email and code input. Wrong code shows error; correct code redirects to `/workspace-name` (which 404s for now — that's Task 9).

- [ ] **Step 7: Commit**

```bash
cd C:\Users\enzo\tiledesk-dashboard
git add src/app/verify-email-waiting/ src/app/app.routing.ts
git commit -m "feat: add verify-email-waiting page

Subscribes to user_bs (not .value) to avoid race with async signin.
Maps server error_codes to specific user messages."
```

---

### Task 9: Dashboard — workspace-name Component

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

- [ ] **Step 2: Create the component (checks no existing projects)**

Create `src/app/workspace-name/workspace-name.component.ts`:

```typescript
import { Component, OnInit, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { AuthService } from '../core/auth.service';
import { ProjectService } from '../services/project.service';

@Component({
  selector: 'appdashboard-workspace-name',
  templateUrl: './workspace-name.component.html',
  styleUrls: ['./workspace-name.component.scss']
})
export class WorkspaceNameComponent implements OnInit, OnDestroy {

  workspaceName: string = '';
  errorMessage: string = '';
  isLoading: boolean = true;

  private userSub: Subscription;

  constructor(
    private auth: AuthService,
    private projectService: ProjectService,
    private router: Router
  ) { }

  ngOnInit() {
    this.userSub = this.auth.user_bs.subscribe((user) => {
      if (!user) {
        this.router.navigate(['/signup']);
        return;
      }
      if (!user.emailverified) {
        this.router.navigate(['/verify-email-waiting']);
        return;
      }

      // Check if user already has projects
      this.projectService.getProjects().subscribe(
        (projects: any[]) => {
          this.isLoading = false;
          if (projects && projects.length > 0) {
            this.router.navigate(['/projects']);
          }
        },
        (err) => {
          this.isLoading = false;
        }
      );
    });
  }

  ngOnDestroy() {
    if (this.userSub) this.userSub.unsubscribe();
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
        this.auth.projectSelected(project, 'workspace-name');
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

**Note:** Verify `projectService.getProjects()` exists with that exact name; if not, use the actual method name (`getAllProjects()`, `getProjectsByUserId()`, etc.). Search before implementing:

```bash
grep -n "public get.*[Pp]rojects\b" "C:/Users/enzo/tiledesk-dashboard/src/app/services/project.service.ts"
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

    <div *ngIf="errorMessage" class="alert alert-danger">{{ errorMessage }}</div>

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

h2 { margin-bottom: 8px; font-size: 24px; color: #333; }
.subtitle { color: #666; margin-bottom: 32px; }

.name-input-group {
  margin-bottom: 16px;
  input {
    width: 100%;
    padding: 14px 16px;
    border: 1px solid #ddd;
    border-radius: 6px;
    font-size: 16px;
    &:focus { outline: none; border-color: #1e88e5; }
  }
}

.create-btn { width: 100%; padding: 14px; font-size: 16px; margin-top: 8px; }

.alert {
  margin-bottom: 12px;
  padding: 10px 16px;
  border-radius: 6px;
  font-size: 14px;
}
```

- [ ] **Step 5: Add route**

In `src/app/app.routing.ts`, add after `verify-email-waiting`:

```typescript
{
  path: 'workspace-name',
  loadChildren: () => import('app/workspace-name/workspace-name.module').then(m => m.WorkspaceNameModule),
  canActivate: [AuthGuard]
},
```

The component itself enforces email verification + no-projects via ngOnInit redirects.

- [ ] **Step 6: Test directly**

Manually navigate. Verify guard logic redirects correctly in 3 cases:
1. Not logged in → /signup
2. Email not verified → /verify-email-waiting
3. Has projects → /projects
4. Eligible → shows form, creates project, redirects to /project/:id/home

- [ ] **Step 7: Commit**

```bash
cd C:\Users\enzo\tiledesk-dashboard
git add src/app/workspace-name/ src/app/app.routing.ts
git commit -m "feat: add workspace-name page

Guards (in component): redirect unauthenticated, unverified, or
already-has-projects users. Creates project with source=signup."
```

---

### Task 10: Dashboard — Modify signup Component (preserve invitation/stored-route)

**Files:**
- Modify: `C:\Users\enzo\tiledesk-dashboard\src\app\auth\signup\signup.component.ts`

- [ ] **Step 1: Replace the inner branch in autoSignin only**

In `signup.component.ts`, find the `autoSignin()` method (line 667). Locate the exact block at lines 686-712. Replace ONLY the `if (self.SKIP_WIZARD === false) { ... }` inner contents — keep `EXIST_STORED_ROUTE` and `SKIP_WIZARD === true` paths intact.

Replace lines 686-712:

```typescript
        if (!self.EXIST_STORED_ROUTE) {
          if (self.SKIP_WIZARD === false) {
            // ChatCase onboarding flow: always go to verify-email-waiting
            // (regardless of areActivePay, no auto-create project)
            self.router.navigate(['/verify-email-waiting']);
          } else {
            self.router.navigate(['/projects']);
          }
        } else {
          self.localDbService.removeFromStorage('wannago')
          self.router.navigate([self.storedRoute]);
        }
```

This:
- Removes the `createNewProject()` call (project is now created in `/workspace-name`)
- Removes the `/onboarding` redirect (replaced by our flow)
- Keeps invitation flow (`SKIP_WIZARD=true` → `/projects`)
- Keeps stored-route flow

- [ ] **Step 2: Verify "email already registered" toast still works**

The existing error handler at line 625 already calls:
```typescript
this.notify.showToast(this.translate.instant('SomethingWentWrongCreatingYourAccount'), 4, 'report_problem')
```

This is the existing pattern — leave as is. The translation key handles the message.

If you want a more specific message for the "already registered" case, edit the i18n translation file later — out of scope for this task.

- [ ] **Step 3: Test the full flow**

1. Open `http://localhost:8081/dashboard/#/signup`
2. Sign up with a NEW email
3. Should redirect to `/verify-email-waiting`
4. Get the code from server logs:
   ```bash
   docker logs server 2>&1 | grep "verify_email_code\|verify-" | tail -3
   ```
   Or from email if SMTP is configured.
5. Enter code → redirects to `/workspace-name`
6. Type a name → creates project → redirects to `/project/:id/home`

- [ ] **Step 4: Commit**

```bash
cd C:\Users\enzo\tiledesk-dashboard
git add src/app/auth/signup/signup.component.ts
git commit -m "feat: signup redirects to verify-email-waiting

Preserves invitation flow (SKIP_WIZARD=true) and stored-route flow.
Removes auto project creation — moved to workspace-name page."
```

---

### Task 11: Dashboard — Add user property to app.component

**Files:**
- Modify: `C:\Users\enzo\tiledesk-dashboard\src\app\app.component.ts`

- [ ] **Step 1: Add public user field**

In `app.component.ts`, near the other public properties (around line 60-90), add:

```typescript
    user: any;
```

- [ ] **Step 2: Set user inside the existing user_bs subscribe**

Find the existing subscription at line 1021:

```typescript
this.auth.user_bs.subscribe((user) => {
```

Add inside that callback as the first line:

```typescript
this.user = user;
```

This ensures `this.user` is updated every time the auth state changes — set on login, cleared on logout.

- [ ] **Step 3: Commit**

```bash
cd C:\Users\enzo\tiledesk-dashboard
git add src/app/app.component.ts
git commit -m "feat: expose user as public property in app.component

Allows template-level checks like *ngIf=user."
```

---

### Task 12: Dashboard — Onboarding Checklist Component

**Files:**
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\onboarding-checklist\onboarding-checklist.component.ts`
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\onboarding-checklist\onboarding-checklist.component.html`
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\onboarding-checklist\onboarding-checklist.component.scss`
- Modify: `C:\Users\enzo\tiledesk-dashboard\src\app\app.module.ts`
- Modify: `C:\Users\enzo\tiledesk-dashboard\src\app\app.component.html`

- [ ] **Step 1: Create the component (filter null project_bs)**

Create `src/app/onboarding-checklist/onboarding-checklist.component.ts`:

```typescript
import { Component, OnInit, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';
import { AuthService } from '../core/auth.service';

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
    // Filter null/undefined to avoid flashing during project switches
    this.subscription = this.auth.project_bs
      .pipe(filter(p => !!p))
      .subscribe((project) => {
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
    if (this.subscription) this.subscription.unsubscribe();
  }

  private loadState() {
    var storageKey = 'checklist_' + this.projectId;
    var saved = localStorage.getItem(storageKey);
    var completedIds: string[] = saved ? (JSON.parse(saved).completed || []) : [];

    this.items = [
      { id: 'whatsapp', label: 'Conectar WhatsApp', route: '/project/' + this.projectId + '/integrations?name=whatsapp', icon: 'chat', completed: completedIds.indexOf('whatsapp') > -1 },
      { id: 'flow', label: 'Criar primeiro fluxo', route: '/project/' + this.projectId + '/cds/chatbot-design-studio', icon: 'account_tree', completed: completedIds.indexOf('flow') > -1 },
      { id: 'welcome', label: 'Personalizar boas-vindas', route: '/project/' + this.projectId + '/widget/set-up', icon: 'waving_hand', completed: completedIds.indexOf('welcome') > -1 },
      { id: 'hours', label: 'Definir horário de atendimento', route: '/project/' + this.projectId + '/hours', icon: 'schedule', completed: completedIds.indexOf('hours') > -1 },
      { id: 'agent', label: 'Convidar um agente', route: '/project/' + this.projectId + '/project-settings/teammates', icon: 'person_add', completed: completedIds.indexOf('agent') > -1 }
    ];

    this.completedCount = this.items.filter(i => i.completed).length;
  }

  private saveState() {
    var storageKey = 'checklist_' + this.projectId;
    var completedIds = this.items.filter(i => i.completed).map(i => i.id);
    localStorage.setItem(storageKey, JSON.stringify({ completed: completedIds }));
  }

  toggleItem(item: ChecklistItem) {
    item.completed = !item.completed;
    this.completedCount = this.items.filter(i => i.completed).length;
    this.saveState();
    if (this.allCompleted()) this.isVisible = false;
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
    return this.items.length > 0 && this.items.every(i => i.completed);
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

    <div *ngFor="let item of items" class="checklist-item" [class.completed]="item.completed">
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
  &.minimized { width: 280px; }
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
  i { font-size: 20px; }
}

.checklist-progress { font-size: 13px; opacity: 0.9; margin-right: 8px; }
.checklist-actions { display: flex; gap: 2px; }

.btn-icon {
  background: none;
  border: none;
  color: white;
  cursor: pointer;
  padding: 2px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  &:hover { background: rgba(255, 255, 255, 0.2); }
  i { font-size: 20px; }
}

.checklist-body { padding: 12px 0; }

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
  &:hover { background: #f5f5f5; }
  &.completed .item-label { text-decoration: line-through; color: #999; }
}

.check-btn {
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  margin-right: 10px;
  display: flex;
  i { font-size: 22px; color: #ccc; }
  .completed & i { color: #4caf50; }
}

.item-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: #333;
  flex: 1;
}

.item-icon { font-size: 18px; color: #888; }
```

- [ ] **Step 4: Declare in app.module.ts**

In `src/app/app.module.ts`, add to imports:
```typescript
import { OnboardingChecklistComponent } from './onboarding-checklist/onboarding-checklist.component';
```

Add `OnboardingChecklistComponent` to the `declarations` array of `@NgModule`.

- [ ] **Step 5: Inject in app.component.html**

In `src/app/app.component.html`, add at the end (before closing tag):

```html
<appdashboard-onboarding-checklist *ngIf="!LOGIN_PAGE && user"></appdashboard-onboarding-checklist>
```

This now works because Task 11 added `public user: any` to app.component.

- [ ] **Step 6: Verify checklist routes exist**

Each `route` in items must point to a real route. Verify:

```bash
grep -E "integrations|cds/chatbot-design-studio|widget/set-up|hours|project-settings/teammates" "C:/Users/enzo/tiledesk-dashboard/src/app/app.routing.ts"
```

Or test by clicking each item in the running dashboard. If any 404s, update the route in the items array.

- [ ] **Step 7: Test in browser**

1. Sign in to a project
2. Verify checklist appears in bottom-right
3. Click each item → navigates to the right page
4. Check items → state persists after refresh
5. Dismiss → stays hidden after refresh
6. Switch to a project older than 30 days → checklist hidden

- [ ] **Step 8: Commit**

```bash
cd C:\Users\enzo\tiledesk-dashboard
git add src/app/onboarding-checklist/ src/app/app.module.ts src/app/app.component.html
git commit -m "feat: add floating onboarding checklist

5-item guided checklist for new projects (<30 days old).
Filters null project_bs to avoid flashing during project switches.
Persists state in localStorage; dismissible."
```

---

### Task 13: Final Integration Test

- [ ] **Step 1: Rebuild server (dashboard auto-reloads on file changes)**

```bash
cd C:\Users\enzo\tiledesk
docker compose up -d --build server
```

Wait for healthy:
```bash
until docker inspect server --format '{{.State.Health.Status}}' 2>/dev/null | grep -q healthy; do sleep 3; done && echo READY
```

- [ ] **Step 2: End-to-end signup → workspace flow**

1. Open `http://localhost:8081/dashboard/#/signup`
2. Sign up with a fresh email
3. Should redirect to `/verify-email-waiting`
4. Get verification code from logs:
   ```bash
   docker logs server 2>&1 | grep "verify-" | tail -2
   ```
   The code is the suffix after `verify-` in the redis key.
5. Enter the code on the page
6. Should redirect to `/workspace-name`
7. Enter a workspace name
8. Should redirect to `/project/:id/home`
9. Onboarding checklist visible bottom-right
10. Verify project profile in MongoDB:
    ```bash
    docker exec mongo mongosh tiledesk --quiet --eval '
      var p = db.projects.find({}, {name:1, "profile.name":1, "profile.type":1, "profile.agents":1, "profile.trialDays":1}).sort({createdAt:-1}).limit(1).toArray();
      printjson(p)
    '
    ```
    Expected: Plan: Pro, type: free, agents: 10, trialDays: 14

- [ ] **Step 3: Test the email gate**

Try to subscribe without verifying:

```bash
curl -s -X POST http://localhost:3000/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"redacted@example.invalid","password":"Test12345","firstname":"Gate","lastname":"Test"}'

TOKEN=$(curl -s -X POST http://localhost:3000/auth/signin \
  -H "Content-Type: application/json" \
  -d '{"email":"redacted@example.invalid","password":"Test12345"}' | python -c "import sys,json; print(json.load(sys.stdin)['token'])")

curl -s -X POST http://localhost:3000/modules/payments/casepay/subscribe \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"any","planKey":"starter"}'
```

Expected: `{"error":"email_not_verified",...}`

- [ ] **Step 4: Test trial expiration**

Backdate a project to expire trial, then make a request — verify auto-downgrade as in Task 4 Step 4.

- [ ] **Step 5: Push all changes**

```bash
cd C:\Users\enzo\tiledesk-server && git push origin master
cd C:\Users\enzo\tiledesk-dashboard && git push origin master
```
