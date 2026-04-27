# Super-Admin Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a super-admin panel where the platform owner (ADMIN_EMAIL) can view and manage all projects, users, subscriptions, and usage across the ChatCase SaaS.

**Architecture:** Phase 1 creates server-side middleware and API endpoints at `/sadmin`. Phase 2 builds the dashboard foundation (AuthService isSuperAdmin, guard, service, routing, sidebar). Phase 3 creates the 4 admin pages (dashboard, projects, users, payments). Each phase produces independently testable software.

**Tech Stack:** Node.js/Express (server), Angular 14 (dashboard), MongoDB/Mongoose

**Spec:** `docs/superpowers/specs/2026-04-27-super-admin-panel-design.md`

---

## File Structure

### Server (C:\Users\enzo\tiledesk-server)
| File | Action | Responsibility |
|---|---|---|
| `middleware/super-admin-check.js` | Create | Middleware that verifies req.user.email === ADMIN_EMAIL |
| `routes/sadmin.js` | Create | All super-admin endpoints (stats, projects, users, payments, plan, trial, quotas) |
| `app.js` | Modify | Mount /sadmin route before /:projectid/ middleware |

### Dashboard (C:\Users\enzo\tiledesk-dashboard)
| File | Action | Responsibility |
|---|---|---|
| `src/app/core/auth.service.ts` | Modify | Save role from login, expose isSuperAdmin |
| `src/app/core/super-admin.guard.ts` | Create | Route guard checking isSuperAdmin |
| `src/app/services/admin.service.ts` | Create | HTTP client for /sadmin/* endpoints |
| `src/app/admin-panel/admin-panel.module.ts` | Create | Lazy-loaded module with child routes |
| `src/app/admin-panel/admin-panel.component.ts/html/scss` | Create | Layout with horizontal nav tabs |
| `src/app/admin-panel/admin-dashboard/admin-dashboard.component.ts/html` | Create | Stats cards page |
| `src/app/admin-panel/admin-projects/admin-projects.component.ts/html` | Create | Projects table with actions |
| `src/app/admin-panel/admin-users/admin-users.component.ts/html` | Create | Users table with search |
| `src/app/admin-panel/admin-payments/admin-payments.component.ts/html` | Create | Payments table with filters |
| `src/app/components/sidebar/sidebar.component.html` | Modify | Add Admin menu item |
| `src/app/components/sidebar/sidebar.component.ts` | Modify | Add isSuperAdmin property |
| `src/app/app.module.ts` | Modify | Register AdminService, SuperAdminGuard |
| `src/app/app.routing.ts` | Modify | Add /admin route |

---

## Phase 1: Backend

### Task 1: Create superAdminCheck middleware

**Files:**
- Create: `C:\Users\enzo\tiledesk-server\middleware\super-admin-check.js`

- [ ] **Step 1: Create the middleware file**

```javascript
var winston = require('../config/winston');

var adminEmail = process.env.ADMIN_EMAIL || 'redacted@example.invalid';

module.exports = function superAdminCheck(req, res, next) {
  if (!req.user || req.user.email !== adminEmail) {
    winston.warn('Super-admin access denied for: ' + (req.user ? req.user.email : 'unauthenticated'));
    return res.status(403).json({ error: 'Super-admin access required' });
  }
  next();
};
```

- [ ] **Step 2: Verify syntax**

```bash
node --check middleware/super-admin-check.js
```

Expected: No output (clean parse).

- [ ] **Step 3: Commit**

```bash
git add middleware/super-admin-check.js
git commit -m "feat: create superAdminCheck middleware"
```

---

### Task 2: Create routes/sadmin.js with all endpoints

**Files:**
- Create: `C:\Users\enzo\tiledesk-server\routes\sadmin.js`

- [ ] **Step 1: Create the full sadmin routes file**

```javascript
var express = require('express');
var router = express.Router();
var passport = require('passport');
var validtoken = require('../middleware/valid-token');
var superAdminCheck = require('../middleware/super-admin-check');
var winston = require('../config/winston');

var Project = require('../models/project');
var User = require('../models/user');
var Project_user = require('../models/project_user');
var Lead = require('../models/lead');
var LeadConstants = require('../models/leadConstants');
var Integration = require('../models/integrations');
var SubscriptionPayment = require('../pubmodules/billing/models/subscription-payment');
var { getPlan, getAllPlans } = require('../pubmodules/billing/plans');

var auth = [passport.authenticate(['basic', 'jwt'], { session: false }), validtoken, superAdminCheck];

var CHANNEL_NAMES = ['whatsapp', 'telegram', 'messenger', 'sms', 'voice', 'voice_twilio'];

var LEGACY_PLAN_MAP = {
  'Sandbox': 'free', 'Basic': 'starter', 'Premium': 'pro', 'Team': 'business',
  'Free': 'free', 'Starter': 'starter', 'Pro': 'pro', 'Business': 'business', 'Custom': 'custom'
};

var VALID_PLAN_KEYS = ['free', 'starter', 'pro', 'business'];

// GET /sadmin/stats
router.get('/stats', auth, async function (req, res) {
  try {
    var totalProjects = await Project.countDocuments();
    var totalUsers = await User.countDocuments({ status: 100 });

    var planAgg = await Project.aggregate([
      { $group: { _id: '$profile.name', count: { $sum: 1 }, type: { $first: '$profile.type' }, billingPeriod: { $first: '$profile.billingPeriod' } } }
    ]);

    var planDistribution = { free: 0, starter: 0, pro: 0, business: 0, custom: 0, other: 0 };
    var monthlyRevenue = 0;

    for (var i = 0; i < planAgg.length; i++) {
      var item = planAgg[i];
      var mapped = LEGACY_PLAN_MAP[item._id] || 'other';
      if (planDistribution[mapped] !== undefined) {
        planDistribution[mapped] += item.count;
      } else {
        planDistribution.other += item.count;
      }
    }

    var paidProjects = await Project.find({ 'profile.type': 'payment' }).select('profile').lean();
    for (var j = 0; j < paidProjects.length; j++) {
      var proj = paidProjects[j];
      var plan = getPlan(proj.profile.name || 'free');
      if (proj.profile.billingPeriod === 'annual') {
        monthlyRevenue += (plan.annualPrice || 0) / 12;
      } else {
        monthlyRevenue += plan.monthlyPrice || 0;
      }
    }

    res.json({
      totalProjects: totalProjects,
      totalUsers: totalUsers,
      monthlyRevenue: Math.round(monthlyRevenue * 100) / 100,
      planDistribution: planDistribution
    });
  } catch (err) {
    winston.error('sadmin stats error', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// GET /sadmin/projects
router.get('/projects', auth, async function (req, res) {
  try {
    var page = parseInt(req.query.page) || 0;
    var limit = parseInt(req.query.limit) || 20;
    var sortField = req.query.sortField || 'createdAt';
    var direction = parseInt(req.query.direction) || -1;

    var match = {};
    if (req.query.planName) match['profile.name'] = req.query.planName;
    if (req.query.planType) match['profile.type'] = req.query.planType;

    var sort = {};
    sort[sortField] = direction;

    var pipeline = [
      { $match: match },
      { $sort: sort },
      { $skip: page * limit },
      { $limit: limit },
      {
        $lookup: {
          from: 'project_users',
          let: { pid: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$id_project', { $toString: '$$pid' }] }, role: 'owner', status: 'active' } },
            { $limit: 1 }
          ],
          as: 'ownerPU'
        }
      },
      { $unwind: { path: '$ownerPU', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'users',
          localField: 'ownerPU.id_user',
          foreignField: '_id',
          as: 'ownerUser'
        }
      },
      { $unwind: { path: '$ownerUser', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          name: 1, createdAt: 1, profile: 1,
          trialExpired: 1, trialDaysLeft: 1,
          ownerEmail: { $ifNull: ['$ownerUser.email', 'N/A'] }
        }
      }
    ];

    var data = await Project.aggregate(pipeline);
    var count = await Project.countDocuments(match);

    res.json({ data: data, count: count, page: page, limit: limit });
  } catch (err) {
    winston.error('sadmin projects error', err);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

// GET /sadmin/users
router.get('/users', auth, async function (req, res) {
  try {
    var page = parseInt(req.query.page) || 0;
    var limit = parseInt(req.query.limit) || 20;
    var search = req.query.search || '';

    var filter = { status: 100 };
    if (search) {
      var regex = new RegExp(search, 'i');
      filter.$or = [{ email: regex }, { firstname: regex }, { lastname: regex }];
    }

    var data = await User.find(filter)
      .select('email firstname lastname emailverified status createdAt')
      .sort({ createdAt: -1 })
      .skip(page * limit)
      .limit(limit)
      .lean();

    var count = await User.countDocuments(filter);

    for (var i = 0; i < data.length; i++) {
      var projectCount = await Project_user.countDocuments({ id_user: data[i]._id, status: 'active' });
      data[i].projectCount = projectCount;
    }

    res.json({ data: data, count: count, page: page, limit: limit });
  } catch (err) {
    winston.error('sadmin users error', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// GET /sadmin/payments
router.get('/payments', auth, async function (req, res) {
  try {
    var page = parseInt(req.query.page) || 0;
    var limit = parseInt(req.query.limit) || 20;

    var filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.project_id) filter.project_id = req.query.project_id;

    var data = await SubscriptionPayment
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(page * limit)
      .limit(limit)
      .lean();

    var count = await SubscriptionPayment.countDocuments(filter);

    for (var i = 0; i < data.length; i++) {
      if (data[i].project_id) {
        var proj = await Project.findById(data[i].project_id).select('name').lean();
        data[i].projectName = proj ? proj.name : 'Deleted';
      }
    }

    res.json({ data: data, count: count, page: page, limit: limit });
  } catch (err) {
    winston.error('sadmin payments error', err);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// PUT /sadmin/projects/:id/plan
router.put('/projects/:id/plan', auth, async function (req, res) {
  try {
    var planKey = req.body.planKey;
    if (!planKey || VALID_PLAN_KEYS.indexOf(planKey) === -1) {
      return res.status(400).json({ error: 'Invalid plan key. Must be one of: ' + VALID_PLAN_KEYS.join(', ') });
    }

    var project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    var plan = getPlan(planKey);
    var update = {
      'profile.name': plan.name,
      'profile.type': plan.type,
      'profile.agents': plan.agents,
      'profile.quotes': plan.quotes,
      'profile.customization': plan.customization
    };

    if (planKey === 'free') {
      update['profile.mandateId'] = null;
      update['profile.pendingPlan'] = null;
      update['profile.billingPeriod'] = null;
    }

    await Project.findByIdAndUpdate(req.params.id, { $set: update });

    var response = { success: true, plan: plan.name };
    if (project.profile.mandateId && planKey !== 'free') {
      response.warning = 'Project has active CasePay mandate. The mandate will continue billing at the previous amount. Consider canceling the mandate.';
    }

    winston.info('sadmin: project ' + req.params.id + ' plan changed to ' + plan.name);
    res.json(response);
  } catch (err) {
    winston.error('sadmin plan change error', err);
    res.status(500).json({ error: 'Failed to change plan' });
  }
});

// PUT /sadmin/projects/:id/trial
router.put('/projects/:id/trial', auth, async function (req, res) {
  try {
    var trialDays = parseInt(req.body.trialDays);
    if (!trialDays || trialDays < 1 || trialDays > 365) {
      return res.status(400).json({ error: 'trialDays must be between 1 and 365' });
    }

    var project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    await Project.findByIdAndUpdate(req.params.id, { $set: { 'profile.trialDays': trialDays } });

    var response = { success: true, trialDays: trialDays };
    if (project.profile.type === 'payment') {
      response.warning = 'Project has active payment. Trial extension has no effect on paid plans.';
    }

    winston.info('sadmin: project ' + req.params.id + ' trial extended to ' + trialDays + ' days');
    res.json(response);
  } catch (err) {
    winston.error('sadmin trial extend error', err);
    res.status(500).json({ error: 'Failed to extend trial' });
  }
});

// PUT /sadmin/projects/:id/quotas
router.put('/projects/:id/quotas', auth, async function (req, res) {
  try {
    var project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    var BOUNDS = { contacts: [0, 1000000], platforms: [0, 100], agents: [0, 10000], chatbots: [0, 10000], kbs: [0, 10000] };
    var update = {};

    var keys = Object.keys(req.body);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var val = req.body[key];
      if (BOUNDS[key] && typeof val === 'number' && val >= BOUNDS[key][0] && val <= BOUNDS[key][1]) {
        if (key === 'agents') {
          update['profile.agents'] = val;
        } else {
          update['profile.quotes.' + key] = val;
        }
      }
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No valid quota fields provided' });
    }

    await Project.findByIdAndUpdate(req.params.id, { $set: update });

    winston.info('sadmin: project ' + req.params.id + ' quotas updated: ' + JSON.stringify(update));
    res.json({ success: true, updated: update });
  } catch (err) {
    winston.error('sadmin quotas update error', err);
    res.status(500).json({ error: 'Failed to update quotas' });
  }
});

module.exports = router;
```

- [ ] **Step 2: Verify syntax**

```bash
node --check routes/sadmin.js
```

- [ ] **Step 3: Commit**

```bash
git add routes/sadmin.js
git commit -m "feat: create super-admin routes with stats, projects, users, payments, plan/trial/quotas management"
```

---

### Task 3: Mount /sadmin route in app.js

**Files:**
- Modify: `C:\Users\enzo\tiledesk-server\app.js`

- [ ] **Step 1: Add require at the top of app.js**

Find where other route requires are declared (around lines 50-80) and add:

```javascript
var sadmin = require('./routes/sadmin');
```

- [ ] **Step 2: Mount the route BEFORE the /:projectid/ middleware**

Find line 573 (`app.use('/projects', project);`) and add AFTER it but BEFORE line 585 (`app.use('/:projectid/', ...`):

```javascript
app.use('/sadmin', sadmin);
```

- [ ] **Step 3: Verify server starts without errors**

```bash
node --check app.js
```

- [ ] **Step 4: Test the stats endpoint**

```bash
# After Docker rebuild
curl -s -X POST http://localhost:3000/auth/signin -H 'Content-Type: application/json' -d '{"email":"redacted@example.invalid","password":"adminadmin"}' > /tmp/signin.json
TOKEN=$(python3 -c "import sys,json; print(json.load(open('/tmp/signin.json'))['token'])")
curl -s http://localhost:3000/sadmin/stats -H "Authorization: $TOKEN" | python3 -m json.tool
```

Expected: JSON with totalProjects, totalUsers, monthlyRevenue, planDistribution.

- [ ] **Step 5: Commit**

```bash
git add app.js
git commit -m "feat: mount /sadmin routes in app.js before /:projectid/ middleware"
```

---

## Phase 2: Dashboard Foundation

### Task 4: Add isSuperAdmin to AuthService

**Files:**
- Modify: `C:\Users\enzo\tiledesk-dashboard\src\app\core\auth.service.ts`

- [ ] **Step 1: Save role from login response**

In the `signin()` method (around line 704), after `user.token = jsonRes['token']`, add:

```typescript
          if (jsonRes['role']) {
            localStorage.setItem('superadmin_role', jsonRes['role']);
          }
```

- [ ] **Step 2: Add isSuperAdmin getter**

In the AuthService class properties (around line 60), add:

```typescript
  get isSuperAdmin(): boolean {
    return localStorage.getItem('superadmin_role') === 'admin';
  }
```

- [ ] **Step 3: Clear role on signOut**

Find the `signOut()` method and add `localStorage.removeItem('superadmin_role');` alongside the other localStorage removals.

- [ ] **Step 4: Commit**

```bash
git add src/app/core/auth.service.ts
git commit -m "feat: save admin role in AuthService, expose isSuperAdmin"
```

---

### Task 5: Create SuperAdminGuard

**Files:**
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\core\super-admin.guard.ts`

- [ ] **Step 1: Create the guard**

```typescript
import { Injectable } from '@angular/core';
import { CanActivate, Router } from '@angular/router';
import { AuthService } from './auth.service';

@Injectable()
export class SuperAdminGuard implements CanActivate {

  constructor(
    private auth: AuthService,
    private router: Router
  ) { }

  canActivate(): boolean {
    if (this.auth.isSuperAdmin) {
      return true;
    }
    this.router.navigate(['/projects']);
    return false;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/core/super-admin.guard.ts
git commit -m "feat: create SuperAdminGuard"
```

---

### Task 6: Create AdminService

**Files:**
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\services\admin.service.ts`

- [ ] **Step 1: Create the service**

```typescript
import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AuthService } from '../core/auth.service';
import { AppConfigService } from './app-config.service';
import { LoggerService } from './logger/logger.service';

@Injectable()
export class AdminService {

  private SERVER_BASE_PATH: string;
  private TOKEN: string;

  constructor(
    private http: HttpClient,
    private auth: AuthService,
    private appConfig: AppConfigService,
    private logger: LoggerService,
  ) {
    this.SERVER_BASE_PATH = this.appConfig.getConfig().SERVER_BASE_URL;
    this.auth.user_bs.subscribe((user) => {
      if (user) {
        this.TOKEN = user.token;
      }
    });
  }

  private getHeaders(): HttpHeaders {
    return new HttpHeaders({
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': this.TOKEN
    });
  }

  getStats(): Observable<any> {
    const url = this.SERVER_BASE_PATH + 'sadmin/stats';
    this.logger.log('[ADMIN-SERV] GET stats', url);
    return this.http.get<any>(url, { headers: this.getHeaders() });
  }

  getProjects(page: number, limit: number, sortField?: string, direction?: number, filters?: any): Observable<any> {
    let url = this.SERVER_BASE_PATH + 'sadmin/projects?page=' + page + '&limit=' + limit;
    if (sortField) url += '&sortField=' + sortField;
    if (direction) url += '&direction=' + direction;
    if (filters) {
      if (filters.planName) url += '&planName=' + filters.planName;
      if (filters.planType) url += '&planType=' + filters.planType;
    }
    this.logger.log('[ADMIN-SERV] GET projects', url);
    return this.http.get<any>(url, { headers: this.getHeaders() });
  }

  getUsers(page: number, limit: number, search?: string): Observable<any> {
    let url = this.SERVER_BASE_PATH + 'sadmin/users?page=' + page + '&limit=' + limit;
    if (search) url += '&search=' + encodeURIComponent(search);
    this.logger.log('[ADMIN-SERV] GET users', url);
    return this.http.get<any>(url, { headers: this.getHeaders() });
  }

  getPayments(page: number, limit: number, filters?: any): Observable<any> {
    let url = this.SERVER_BASE_PATH + 'sadmin/payments?page=' + page + '&limit=' + limit;
    if (filters) {
      if (filters.status) url += '&status=' + filters.status;
      if (filters.project_id) url += '&project_id=' + filters.project_id;
    }
    this.logger.log('[ADMIN-SERV] GET payments', url);
    return this.http.get<any>(url, { headers: this.getHeaders() });
  }

  updateProjectPlan(projectId: string, planKey: string): Observable<any> {
    const url = this.SERVER_BASE_PATH + 'sadmin/projects/' + projectId + '/plan';
    this.logger.log('[ADMIN-SERV] PUT plan', url);
    return this.http.put<any>(url, { planKey }, { headers: this.getHeaders() });
  }

  extendTrial(projectId: string, trialDays: number): Observable<any> {
    const url = this.SERVER_BASE_PATH + 'sadmin/projects/' + projectId + '/trial';
    this.logger.log('[ADMIN-SERV] PUT trial', url);
    return this.http.put<any>(url, { trialDays }, { headers: this.getHeaders() });
  }

  updateQuotas(projectId: string, quotas: any): Observable<any> {
    const url = this.SERVER_BASE_PATH + 'sadmin/projects/' + projectId + '/quotas';
    this.logger.log('[ADMIN-SERV] PUT quotas', url);
    return this.http.put<any>(url, quotas, { headers: this.getHeaders() });
  }
}
```

- [ ] **Step 2: Register in app.module.ts**

Add import: `import { AdminService } from './services/admin.service';`
Add import: `import { SuperAdminGuard } from './core/super-admin.guard';`
Add both to providers array (after CasepayService).

- [ ] **Step 3: Commit**

```bash
git add src/app/services/admin.service.ts src/app/app.module.ts
git commit -m "feat: create AdminService and register with SuperAdminGuard"
```

---

### Task 7: Add Admin item to sidebar

**Files:**
- Modify: `C:\Users\enzo\tiledesk-dashboard\src\app\components\sidebar\sidebar.component.ts`
- Modify: `C:\Users\enzo\tiledesk-dashboard\src\app\components\sidebar\sidebar.component.html`

- [ ] **Step 1: Add isSuperAdmin property to sidebar TS**

In `sidebar.component.ts`, around line 267 (after the `isVisible*` declarations), add:

```typescript
  isSuperAdmin: boolean = false;
```

In `ngOnInit()`, add (after existing initialization code):

```typescript
    this.isSuperAdmin = localStorage.getItem('superadmin_role') === 'admin';
```

- [ ] **Step 2: Add Admin item to sidebar HTML**

In `sidebar.component.html`, find the sidebar-separator div (around line 453). Insert BEFORE it:

```html
    <!-- Admin Panel -->
    <ng-container *ngIf="isSuperAdmin">
      <div *ngIf="isSuperAdmin" matTooltip="Admin" #tooltip="matTooltip" matTooltipPosition='right'
        class="sidebar-item-container" routerLinkActive="item-active">
        <a routerLink="/admin" routerLinkActive="item-active">
          <mat-icon class="sidebar-item-icon">admin_panel_settings</mat-icon>
        </a>
      </div>
    </ng-container>
```

- [ ] **Step 3: Commit**

```bash
git add src/app/components/sidebar/sidebar.component.ts src/app/components/sidebar/sidebar.component.html
git commit -m "feat: add Admin item to sidebar for super-admin users"
```

---

### Task 8: Add admin route to app.routing.ts

**Files:**
- Modify: `C:\Users\enzo\tiledesk-dashboard\src\app\app.routing.ts`

- [ ] **Step 1: Import SuperAdminGuard**

At the top of app.routing.ts, after the AdminGuard import (line 10), add:

```typescript
import { SuperAdminGuard } from './core/super-admin.guard';
```

- [ ] **Step 2: Add admin route**

In the routes array, BEFORE the project-scoped routes (around line 168), add:

```typescript
  // Super Admin Panel
  {
    path: 'admin',
    loadChildren: () => import('app/admin-panel/admin-panel.module').then(m => m.AdminPanelModule),
    canActivate: [AuthGuard, SuperAdminGuard],
  },
```

- [ ] **Step 3: Commit**

```bash
git add src/app/app.routing.ts
git commit -m "feat: add /admin route with SuperAdminGuard"
```

---

## Phase 3: Dashboard Admin Pages

### Task 9: Create admin-panel module and layout component

**Files:**
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\admin-panel\admin-panel.module.ts`
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\admin-panel\admin-panel.component.ts`
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\admin-panel\admin-panel.component.html`
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\admin-panel\admin-panel.component.scss`

- [ ] **Step 1: Create the module with child routes**

```typescript
import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule, Routes } from '@angular/router';
import { AdminPanelComponent } from './admin-panel.component';
import { AdminDashboardComponent } from './admin-dashboard/admin-dashboard.component';
import { AdminProjectsComponent } from './admin-projects/admin-projects.component';
import { AdminUsersComponent } from './admin-users/admin-users.component';
import { AdminPaymentsComponent } from './admin-payments/admin-payments.component';

const routes: Routes = [
  {
    path: '',
    component: AdminPanelComponent,
    children: [
      { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
      { path: 'dashboard', component: AdminDashboardComponent },
      { path: 'projects', component: AdminProjectsComponent },
      { path: 'users', component: AdminUsersComponent },
      { path: 'payments', component: AdminPaymentsComponent },
    ]
  }
];

@NgModule({
  declarations: [
    AdminPanelComponent,
    AdminDashboardComponent,
    AdminProjectsComponent,
    AdminUsersComponent,
    AdminPaymentsComponent,
  ],
  imports: [
    CommonModule,
    FormsModule,
    RouterModule.forChild(routes)
  ]
})
export class AdminPanelModule { }
```

- [ ] **Step 2: Create the layout component (TS)**

```typescript
import { Component } from '@angular/core';

@Component({
  selector: 'app-admin-panel',
  templateUrl: './admin-panel.component.html',
  styleUrls: ['./admin-panel.component.scss']
})
export class AdminPanelComponent { }
```

- [ ] **Step 3: Create the layout component (HTML)**

```html
<div class="admin-container">
  <div class="admin-header">
    <h1>Painel Administrativo</h1>
  </div>
  <nav class="admin-nav">
    <a routerLink="dashboard" routerLinkActive="active">Dashboard</a>
    <a routerLink="projects" routerLinkActive="active">Projetos</a>
    <a routerLink="users" routerLinkActive="active">Usuarios</a>
    <a routerLink="payments" routerLinkActive="active">Pagamentos</a>
  </nav>
  <div class="admin-content">
    <router-outlet></router-outlet>
  </div>
</div>
```

- [ ] **Step 4: Create the layout SCSS**

```scss
.admin-container {
  padding: 24px 32px;
  max-width: 1400px;
  margin: 0 auto;
}

.admin-header {
  h1 { font-size: 24px; font-weight: 700; color: #333; margin: 0 0 16px; }
}

.admin-nav {
  display: flex;
  gap: 0;
  border-bottom: 2px solid #e0e0e0;
  margin-bottom: 24px;
  a {
    padding: 10px 20px;
    font-size: 14px;
    font-weight: 500;
    color: #666;
    text-decoration: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -2px;
    transition: all 0.2s;
    &:hover { color: #333; }
    &.active {
      color: #1e88e5;
      border-bottom-color: #1e88e5;
      font-weight: 600;
    }
  }
}

.admin-content {
  min-height: 400px;
}
```

- [ ] **Step 5: Commit**

```bash
git add src/app/admin-panel/
git commit -m "feat: create admin-panel module with layout and navigation tabs"
```

---

### Task 10: Create AdminDashboard page (stats)

**Files:**
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\admin-panel\admin-dashboard\admin-dashboard.component.ts`
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\admin-panel\admin-dashboard\admin-dashboard.component.html`

- [ ] **Step 1: Create the component TS**

```typescript
import { Component, OnInit } from '@angular/core';
import { AdminService } from '../../services/admin.service';

@Component({
  selector: 'app-admin-dashboard',
  templateUrl: './admin-dashboard.component.html'
})
export class AdminDashboardComponent implements OnInit {
  stats: any = null;
  isLoading = true;
  errorMessage = '';

  planDisplayNames: any = { free: 'Iniciante', starter: 'Standard', pro: 'Pro', business: 'Enterprise', custom: 'Custom', other: 'Outros' };

  constructor(private adminService: AdminService) { }

  ngOnInit() {
    this.loadStats();
  }

  loadStats() {
    this.isLoading = true;
    this.adminService.getStats().subscribe(
      (data) => { this.stats = data; this.isLoading = false; },
      (err) => { this.errorMessage = 'Erro ao carregar estatisticas'; this.isLoading = false; }
    );
  }

  getPlanKeys(): string[] {
    if (!this.stats) return [];
    return Object.keys(this.stats.planDistribution);
  }
}
```

- [ ] **Step 2: Create the component HTML**

```html
<div *ngIf="isLoading" style="text-align: center; padding: 40px;">Carregando...</div>
<div *ngIf="errorMessage" style="color: red; padding: 20px;">{{ errorMessage }}</div>

<div *ngIf="stats && !isLoading" class="stats-grid">
  <div class="stat-card">
    <div class="stat-value">{{ stats.totalProjects }}</div>
    <div class="stat-label">Projetos</div>
  </div>
  <div class="stat-card">
    <div class="stat-value">{{ stats.totalUsers }}</div>
    <div class="stat-label">Usuarios</div>
  </div>
  <div class="stat-card">
    <div class="stat-value">R$ {{ stats.monthlyRevenue | number:'1.2-2' }}</div>
    <div class="stat-label">Receita mensal estimada</div>
  </div>
</div>

<div *ngIf="stats && !isLoading" style="margin-top: 24px;">
  <h3 style="font-size: 16px; font-weight: 600; color: #333; margin-bottom: 12px;">Distribuicao por plano</h3>
  <div class="plan-distribution">
    <div *ngFor="let key of getPlanKeys()" class="plan-dist-item">
      <span class="plan-dist-name">{{ planDisplayNames[key] || key }}</span>
      <span class="plan-dist-count">{{ stats.planDistribution[key] }}</span>
    </div>
  </div>
</div>
```

- [ ] **Step 3: Add styles inline or to parent SCSS**

Add to `admin-panel.component.scss`:

```scss
.stats-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.stat-card {
  background: white;
  border: 1px solid #e0e0e0;
  border-radius: 12px;
  padding: 24px;
  text-align: center;
}

.stat-value {
  font-size: 32px;
  font-weight: 700;
  color: #333;
}

.stat-label {
  font-size: 14px;
  color: #999;
  margin-top: 4px;
}

.plan-distribution {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.plan-dist-item {
  background: white;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 12px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.plan-dist-name {
  font-size: 13px;
  color: #666;
}

.plan-dist-count {
  font-size: 24px;
  font-weight: 700;
  color: #333;
}
```

- [ ] **Step 4: Commit**

```bash
git add src/app/admin-panel/admin-dashboard/
git commit -m "feat: create admin dashboard page with stats cards"
```

---

### Task 11: Create AdminProjects page (table + actions)

**Files:**
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\admin-panel\admin-projects\admin-projects.component.ts`
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\admin-panel\admin-projects\admin-projects.component.html`

- [ ] **Step 1: Create the component TS**

```typescript
import { Component, OnInit } from '@angular/core';
import { AdminService } from '../../services/admin.service';

@Component({
  selector: 'app-admin-projects',
  templateUrl: './admin-projects.component.html'
})
export class AdminProjectsComponent implements OnInit {
  projects: any[] = [];
  totalCount = 0;
  page = 0;
  limit = 20;
  isLoading = true;
  filterPlanName = '';
  filterPlanType = '';

  showPlanModal = false;
  showTrialModal = false;
  showQuotasModal = false;
  selectedProject: any = null;
  modalPlanKey = '';
  modalTrialDays = 14;
  modalQuotas: any = { contacts: 0, platforms: 0, agents: 0, chatbots: 0, kbs: 0 };
  modalMessage = '';

  planDisplayNames: any = { Free: 'Iniciante', Starter: 'Standard', Pro: 'Pro', Business: 'Enterprise', Custom: 'Custom' };

  constructor(private adminService: AdminService) { }

  ngOnInit() { this.loadProjects(); }

  loadProjects() {
    this.isLoading = true;
    const filters: any = {};
    if (this.filterPlanName) filters.planName = this.filterPlanName;
    if (this.filterPlanType) filters.planType = this.filterPlanType;
    this.adminService.getProjects(this.page, this.limit, 'createdAt', -1, filters).subscribe(
      (res) => { this.projects = res.data; this.totalCount = res.count; this.isLoading = false; },
      () => { this.isLoading = false; }
    );
  }

  nextPage() { if ((this.page + 1) * this.limit < this.totalCount) { this.page++; this.loadProjects(); } }
  prevPage() { if (this.page > 0) { this.page--; this.loadProjects(); } }

  openPlanModal(project: any) {
    this.selectedProject = project;
    this.modalPlanKey = '';
    this.modalMessage = '';
    this.showPlanModal = true;
  }

  savePlan() {
    if (!this.modalPlanKey) return;
    this.adminService.updateProjectPlan(this.selectedProject._id, this.modalPlanKey).subscribe(
      (res) => { this.modalMessage = 'Plano alterado.' + (res.warning ? ' ' + res.warning : ''); this.loadProjects(); },
      (err) => { this.modalMessage = 'Erro: ' + (err.error?.error || 'Falha'); }
    );
  }

  openTrialModal(project: any) {
    this.selectedProject = project;
    this.modalTrialDays = 14;
    this.modalMessage = '';
    this.showTrialModal = true;
  }

  saveTrial() {
    this.adminService.extendTrial(this.selectedProject._id, this.modalTrialDays).subscribe(
      (res) => { this.modalMessage = 'Trial estendido.' + (res.warning ? ' ' + res.warning : ''); this.loadProjects(); },
      (err) => { this.modalMessage = 'Erro: ' + (err.error?.error || 'Falha'); }
    );
  }

  openQuotasModal(project: any) {
    this.selectedProject = project;
    this.modalQuotas = {
      contacts: project.profile?.quotes?.contacts || 0,
      platforms: project.profile?.quotes?.platforms || 0,
      agents: project.profile?.agents || 0,
      chatbots: project.profile?.quotes?.chatbots || 0,
      kbs: project.profile?.quotes?.kbs || 0
    };
    this.modalMessage = '';
    this.showQuotasModal = true;
  }

  saveQuotas() {
    this.adminService.updateQuotas(this.selectedProject._id, this.modalQuotas).subscribe(
      (res) => { this.modalMessage = 'Quotas atualizadas.'; this.loadProjects(); },
      (err) => { this.modalMessage = 'Erro: ' + (err.error?.error || 'Falha'); }
    );
  }

  closeModals() {
    this.showPlanModal = false;
    this.showTrialModal = false;
    this.showQuotasModal = false;
    this.selectedProject = null;
    this.modalMessage = '';
  }
}
```

- [ ] **Step 2: Create the component HTML**

```html
<!-- Filters -->
<div style="display: flex; gap: 12px; margin-bottom: 16px;">
  <select [(ngModel)]="filterPlanType" (change)="page=0; loadProjects()">
    <option value="">Todos os tipos</option>
    <option value="free">Free</option>
    <option value="payment">Pagos</option>
  </select>
  <select [(ngModel)]="filterPlanName" (change)="page=0; loadProjects()">
    <option value="">Todos os planos</option>
    <option value="Free">Free</option>
    <option value="Starter">Starter</option>
    <option value="Pro">Pro</option>
    <option value="Business">Business</option>
    <option value="Custom">Custom</option>
  </select>
</div>

<div *ngIf="isLoading" style="text-align: center; padding: 40px;">Carregando...</div>

<table *ngIf="!isLoading" style="width: 100%; border-collapse: collapse; font-size: 13px;">
  <thead>
    <tr style="border-bottom: 2px solid #e0e0e0; text-align: left;">
      <th style="padding: 8px;">Nome</th>
      <th style="padding: 8px;">Owner</th>
      <th style="padding: 8px;">Plano</th>
      <th style="padding: 8px;">Tipo</th>
      <th style="padding: 8px;">Contatos</th>
      <th style="padding: 8px;">Membros</th>
      <th style="padding: 8px;">Criado em</th>
      <th style="padding: 8px;">Acoes</th>
    </tr>
  </thead>
  <tbody>
    <tr *ngFor="let p of projects" style="border-bottom: 1px solid #f0f0f0;">
      <td style="padding: 8px;">{{ p.name }}</td>
      <td style="padding: 8px;">{{ p.ownerEmail }}</td>
      <td style="padding: 8px;">{{ planDisplayNames[p.profile?.name] || p.profile?.name }}</td>
      <td style="padding: 8px;">
        <span [style.color]="p.profile?.type === 'payment' ? '#4caf50' : '#999'">{{ p.profile?.type }}</span>
      </td>
      <td style="padding: 8px;">{{ p.profile?.quotes?.contacts || '—' }}</td>
      <td style="padding: 8px;">{{ p.profile?.agents || '—' }}</td>
      <td style="padding: 8px;">{{ p.createdAt | date:'dd/MM/yyyy' }}</td>
      <td style="padding: 8px;">
        <button type="button" style="font-size: 11px; padding: 2px 8px; margin-right: 4px; cursor: pointer;" (click)="openPlanModal(p)">Plano</button>
        <button type="button" style="font-size: 11px; padding: 2px 8px; margin-right: 4px; cursor: pointer;" (click)="openTrialModal(p)">Trial</button>
        <button type="button" style="font-size: 11px; padding: 2px 8px; cursor: pointer;" (click)="openQuotasModal(p)">Quotas</button>
      </td>
    </tr>
  </tbody>
</table>

<!-- Pagination -->
<div style="display: flex; justify-content: space-between; align-items: center; margin-top: 12px; font-size: 13px;">
  <span>{{ totalCount }} projetos | Pagina {{ page + 1 }}</span>
  <div>
    <button type="button" [disabled]="page === 0" (click)="prevPage()" style="margin-right: 8px;">Anterior</button>
    <button type="button" [disabled]="(page + 1) * limit >= totalCount" (click)="nextPage()">Proxima</button>
  </div>
</div>

<!-- Plan Modal -->
<div *ngIf="showPlanModal" style="position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 9999;">
  <div style="background: white; padding: 24px; border-radius: 12px; width: 350px;" (click)="$event.stopPropagation()">
    <h3 style="margin: 0 0 16px;">Alterar plano: {{ selectedProject?.name }}</h3>
    <select [(ngModel)]="modalPlanKey" style="width: 100%; padding: 8px; margin-bottom: 12px;">
      <option value="">Selecione...</option>
      <option value="free">Iniciante (Free)</option>
      <option value="starter">Standard (Starter)</option>
      <option value="pro">Pro</option>
      <option value="business">Enterprise (Business)</option>
    </select>
    <div *ngIf="modalMessage" style="font-size: 12px; color: #666; margin-bottom: 8px;">{{ modalMessage }}</div>
    <div style="display: flex; gap: 8px; justify-content: flex-end;">
      <button type="button" (click)="closeModals()">Cancelar</button>
      <button type="button" (click)="savePlan()" [disabled]="!modalPlanKey" style="background: #1e88e5; color: white; border: none; padding: 6px 16px; border-radius: 6px; cursor: pointer;">Salvar</button>
    </div>
  </div>
</div>

<!-- Trial Modal -->
<div *ngIf="showTrialModal" style="position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 9999;">
  <div style="background: white; padding: 24px; border-radius: 12px; width: 350px;" (click)="$event.stopPropagation()">
    <h3 style="margin: 0 0 16px;">Estender trial: {{ selectedProject?.name }}</h3>
    <input type="number" [(ngModel)]="modalTrialDays" min="1" max="365" style="width: 100%; padding: 8px; margin-bottom: 12px;" />
    <div *ngIf="modalMessage" style="font-size: 12px; color: #666; margin-bottom: 8px;">{{ modalMessage }}</div>
    <div style="display: flex; gap: 8px; justify-content: flex-end;">
      <button type="button" (click)="closeModals()">Cancelar</button>
      <button type="button" (click)="saveTrial()" style="background: #1e88e5; color: white; border: none; padding: 6px 16px; border-radius: 6px; cursor: pointer;">Salvar</button>
    </div>
  </div>
</div>

<!-- Quotas Modal -->
<div *ngIf="showQuotasModal" style="position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 9999;">
  <div style="background: white; padding: 24px; border-radius: 12px; width: 400px;" (click)="$event.stopPropagation()">
    <h3 style="margin: 0 0 16px;">Override quotas: {{ selectedProject?.name }}</h3>
    <div *ngFor="let field of ['contacts', 'platforms', 'agents', 'chatbots', 'kbs']" style="margin-bottom: 8px;">
      <label style="font-size: 13px; display: block; margin-bottom: 2px;">{{ field }}</label>
      <input type="number" [(ngModel)]="modalQuotas[field]" min="0" style="width: 100%; padding: 6px;" />
    </div>
    <div *ngIf="modalMessage" style="font-size: 12px; color: #666; margin-bottom: 8px;">{{ modalMessage }}</div>
    <div style="display: flex; gap: 8px; justify-content: flex-end;">
      <button type="button" (click)="closeModals()">Cancelar</button>
      <button type="button" (click)="saveQuotas()" style="background: #1e88e5; color: white; border: none; padding: 6px 16px; border-radius: 6px; cursor: pointer;">Salvar</button>
    </div>
  </div>
</div>
```

- [ ] **Step 3: Commit**

```bash
git add src/app/admin-panel/admin-projects/
git commit -m "feat: create admin projects page with table, pagination, plan/trial/quotas modals"
```

---

### Task 12: Create AdminUsers page

**Files:**
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\admin-panel\admin-users\admin-users.component.ts`
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\admin-panel\admin-users\admin-users.component.html`

- [ ] **Step 1: Create the component TS**

```typescript
import { Component, OnInit } from '@angular/core';
import { AdminService } from '../../services/admin.service';

@Component({
  selector: 'app-admin-users',
  templateUrl: './admin-users.component.html'
})
export class AdminUsersComponent implements OnInit {
  users: any[] = [];
  totalCount = 0;
  page = 0;
  limit = 20;
  isLoading = true;
  searchText = '';

  constructor(private adminService: AdminService) { }

  ngOnInit() { this.loadUsers(); }

  loadUsers() {
    this.isLoading = true;
    this.adminService.getUsers(this.page, this.limit, this.searchText).subscribe(
      (res) => { this.users = res.data; this.totalCount = res.count; this.isLoading = false; },
      () => { this.isLoading = false; }
    );
  }

  onSearch() { this.page = 0; this.loadUsers(); }
  nextPage() { if ((this.page + 1) * this.limit < this.totalCount) { this.page++; this.loadUsers(); } }
  prevPage() { if (this.page > 0) { this.page--; this.loadUsers(); } }
}
```

- [ ] **Step 2: Create the component HTML**

```html
<div style="margin-bottom: 16px;">
  <input type="text" [(ngModel)]="searchText" placeholder="Buscar por email ou nome..."
    style="padding: 8px 12px; width: 300px; border: 1px solid #ccc; border-radius: 6px;"
    (keyup.enter)="onSearch()" />
  <button type="button" (click)="onSearch()" style="margin-left: 8px; padding: 8px 16px; cursor: pointer;">Buscar</button>
</div>

<div *ngIf="isLoading" style="text-align: center; padding: 40px;">Carregando...</div>

<table *ngIf="!isLoading" style="width: 100%; border-collapse: collapse; font-size: 13px;">
  <thead>
    <tr style="border-bottom: 2px solid #e0e0e0; text-align: left;">
      <th style="padding: 8px;">Nome</th>
      <th style="padding: 8px;">Email</th>
      <th style="padding: 8px;">Verificado</th>
      <th style="padding: 8px;">Projetos</th>
      <th style="padding: 8px;">Criado em</th>
    </tr>
  </thead>
  <tbody>
    <tr *ngFor="let u of users" style="border-bottom: 1px solid #f0f0f0;">
      <td style="padding: 8px;">{{ u.firstname }} {{ u.lastname }}</td>
      <td style="padding: 8px;">{{ u.email }}</td>
      <td style="padding: 8px;">
        <span [style.color]="u.emailverified ? '#4caf50' : '#e53935'">{{ u.emailverified ? 'Sim' : 'Nao' }}</span>
      </td>
      <td style="padding: 8px;">{{ u.projectCount }}</td>
      <td style="padding: 8px;">{{ u.createdAt | date:'dd/MM/yyyy' }}</td>
    </tr>
  </tbody>
</table>

<div style="display: flex; justify-content: space-between; align-items: center; margin-top: 12px; font-size: 13px;">
  <span>{{ totalCount }} usuarios | Pagina {{ page + 1 }}</span>
  <div>
    <button type="button" [disabled]="page === 0" (click)="prevPage()" style="margin-right: 8px;">Anterior</button>
    <button type="button" [disabled]="(page + 1) * limit >= totalCount" (click)="nextPage()">Proxima</button>
  </div>
</div>
```

- [ ] **Step 3: Commit**

```bash
git add src/app/admin-panel/admin-users/
git commit -m "feat: create admin users page with search and pagination"
```

---

### Task 13: Create AdminPayments page

**Files:**
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\admin-panel\admin-payments\admin-payments.component.ts`
- Create: `C:\Users\enzo\tiledesk-dashboard\src\app\admin-panel\admin-payments\admin-payments.component.html`

- [ ] **Step 1: Create the component TS**

```typescript
import { Component, OnInit } from '@angular/core';
import { AdminService } from '../../services/admin.service';

@Component({
  selector: 'app-admin-payments',
  templateUrl: './admin-payments.component.html'
})
export class AdminPaymentsComponent implements OnInit {
  payments: any[] = [];
  totalCount = 0;
  page = 0;
  limit = 20;
  isLoading = true;
  filterStatus = '';

  constructor(private adminService: AdminService) { }

  ngOnInit() { this.loadPayments(); }

  loadPayments() {
    this.isLoading = true;
    const filters: any = {};
    if (this.filterStatus) filters.status = this.filterStatus;
    this.adminService.getPayments(this.page, this.limit, filters).subscribe(
      (res) => { this.payments = res.data; this.totalCount = res.count; this.isLoading = false; },
      () => { this.isLoading = false; }
    );
  }

  onFilterChange() { this.page = 0; this.loadPayments(); }
  nextPage() { if ((this.page + 1) * this.limit < this.totalCount) { this.page++; this.loadPayments(); } }
  prevPage() { if (this.page > 0) { this.page--; this.loadPayments(); } }
}
```

- [ ] **Step 2: Create the component HTML**

```html
<div style="margin-bottom: 16px;">
  <select [(ngModel)]="filterStatus" (change)="onFilterChange()">
    <option value="">Todos os status</option>
    <option value="created">Criado</option>
    <option value="AUTHORIZED">Autorizado</option>
    <option value="active">Ativo</option>
    <option value="canceled">Cancelado</option>
    <option value="expired">Expirado</option>
  </select>
</div>

<div *ngIf="isLoading" style="text-align: center; padding: 40px;">Carregando...</div>

<table *ngIf="!isLoading" style="width: 100%; border-collapse: collapse; font-size: 13px;">
  <thead>
    <tr style="border-bottom: 2px solid #e0e0e0; text-align: left;">
      <th style="padding: 8px;">Projeto</th>
      <th style="padding: 8px;">Plano</th>
      <th style="padding: 8px;">Valor</th>
      <th style="padding: 8px;">Tipo</th>
      <th style="padding: 8px;">Status</th>
      <th style="padding: 8px;">Mandate</th>
      <th style="padding: 8px;">Data</th>
    </tr>
  </thead>
  <tbody>
    <tr *ngFor="let p of payments" style="border-bottom: 1px solid #f0f0f0;">
      <td style="padding: 8px;">{{ p.projectName || p.project_id }}</td>
      <td style="padding: 8px;">{{ p.plan_name }}</td>
      <td style="padding: 8px;">{{ p.amount ? 'R$ ' + p.amount : '—' }}</td>
      <td style="padding: 8px;">{{ p.event_type }}</td>
      <td style="padding: 8px;">
        <span [style.color]="p.status === 'AUTHORIZED' || p.status === 'active' ? '#4caf50' : (p.status === 'canceled' ? '#e53935' : '#999')">{{ p.status }}</span>
      </td>
      <td style="padding: 8px; font-size: 11px;">{{ p.mandate_id ? (p.mandate_id | slice:0:12) + '...' : '—' }}</td>
      <td style="padding: 8px;">{{ p.createdAt | date:'dd/MM/yyyy HH:mm' }}</td>
    </tr>
  </tbody>
</table>

<div style="display: flex; justify-content: space-between; align-items: center; margin-top: 12px; font-size: 13px;">
  <span>{{ totalCount }} pagamentos | Pagina {{ page + 1 }}</span>
  <div>
    <button type="button" [disabled]="page === 0" (click)="prevPage()" style="margin-right: 8px;">Anterior</button>
    <button type="button" [disabled]="(page + 1) * limit >= totalCount" (click)="nextPage()">Proxima</button>
  </div>
</div>
```

- [ ] **Step 3: Commit**

```bash
git add src/app/admin-panel/admin-payments/
git commit -m "feat: create admin payments page with status filter and pagination"
```

---

### Task 14: Docker rebuild and E2E test

- [ ] **Step 1: Rebuild server and dashboard**

```bash
cd C:\Users\enzo\tiledesk
docker compose up -d --build server dashboard
docker compose restart proxy
```

- [ ] **Step 2: Test /sadmin/stats via API**

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/auth/signin -H 'Content-Type: application/json' -d '{"email":"redacted@example.invalid","password":"adminadmin"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
curl -s http://localhost:3000/sadmin/stats -H "Authorization: $TOKEN" | python3 -m json.tool
```

- [ ] **Step 3: Test admin panel in browser**

Navigate to `http://localhost:8081/dashboard/#/admin` with redacted@example.invalid. Verify:
- Nav tabs render (Dashboard, Projetos, Usuarios, Pagamentos)
- Stats cards show correct numbers
- Projects table lists all projects with owner email
- Plan/Trial/Quotas modals work
- Users table with search works
- Payments table with filters works

- [ ] **Step 4: Verify non-admin cannot access**

Login with redacted@example.invalid, navigate to `/admin`. Should redirect to `/projects`.

---

## Self-Review

### Spec Coverage

| Spec Section | Task(s) | Covered? |
|---|---|---|
| superAdminCheck middleware | Task 1 | ✅ |
| routes/sadmin.js | Task 2 | ✅ |
| Mount in app.js | Task 3 | ✅ |
| AuthService isSuperAdmin | Task 4 | ✅ |
| SuperAdminGuard | Task 5 | ✅ |
| AdminService | Task 6 | ✅ |
| Sidebar Admin item | Task 7 | ✅ |
| App routing /admin | Task 8 | ✅ |
| Admin module + layout | Task 9 | ✅ |
| Dashboard stats page | Task 10 | ✅ |
| Projects table + actions | Task 11 | ✅ |
| Users table + search | Task 12 | ✅ |
| Payments table + filters | Task 13 | ✅ |
| Middleware chain [passport, validtoken, superAdminCheck] | Task 2 (auth array) | ✅ |
| planKey allowlist validation | Task 2 (VALID_PLAN_KEYS) | ✅ |
| Quota bounds validation | Task 2 (BOUNDS object) | ✅ |
| Warning mandate ativo | Task 2 (plan endpoint) | ✅ |
| Warning trial for paid | Task 2 (trial endpoint) | ✅ |
| Revenue with billingPeriod | Task 2 (stats endpoint) | ✅ |
| Legacy plan mapping | Task 2 (LEGACY_PLAN_MAP) | ✅ |
| Aggregate pipeline owner email | Task 2 ($lookup) | ✅ |
| Route before /:projectid/ | Task 3 | ✅ |
