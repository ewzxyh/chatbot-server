# Transactional Emails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 5 transactional emails for the ChatCase SaaS lifecycle: welcome, payment confirmed, trial expiring, trial expired, plan canceled.

**Architecture:** Add 5 methods to the existing emailService.js following the Handlebars template pattern. Create 5 HTML templates. Add triggers in auth.js verifyemail endpoint (welcome, after email verification), billing/index.js (payment/cancel), trial-expiration.js (trial expired), and a new node-schedule cron task (trial expiring). Use deduplication flags for trial emails.

**Tech Stack:** Nodemailer, Handlebars, node-schedule

**Spec:** `docs/superpowers/specs/2026-04-27-transactional-emails-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `template/email/welcome.html` | Create | Welcome email template |
| `template/email/paymentConfirmed.html` | Create | Payment/upgrade confirmation template |
| `template/email/trialExpiring.html` | Create | Trial expiring warning template |
| `template/email/trialExpired.html` | Create | Trial expired notification template |
| `template/email/planCanceled.html` | Create | Plan canceled notification template |
| `services/emailService.js` | Modify | 5 new send methods |
| `models/profile.js` | Modify | Add trialExpiringNotified, trialExpiredNotified fields |
| `routes/auth.js` | Modify | Trigger welcome email after email verification (in verifyemail endpoint) |
| `pubmodules/billing/index.js` | Modify | Trigger payment confirmed + plan canceled emails |
| `middleware/trial-expiration.js` | Modify | Trigger trial expired email |
| `pubmodules/scheduler/tasks/trialExpiringNotificationTask.js` | Create | Cron task for trial expiring emails |
| `pubmodules/scheduler/taskRunner.js` | Modify | Register new cron task |

---

### Task 1: Create 5 email templates

**Files:**
- Create: `C:\Users\enzo\tiledesk-server\template\email\welcome.html`
- Create: `C:\Users\enzo\tiledesk-server\template\email\paymentConfirmed.html`
- Create: `C:\Users\enzo\tiledesk-server\template\email\trialExpiring.html`
- Create: `C:\Users\enzo\tiledesk-server\template\email\trialExpired.html`
- Create: `C:\Users\enzo\tiledesk-server\template\email\planCanceled.html`

All templates follow the exact same HTML structure and inline style pattern as `verify.html`: XHTML 1.0 Transitional, full inline `style="..."` attributes on every element (no `<style>` block with classes -- email clients strip it), `table.body-wrap` (100% width, #f6f6f6 bg), `td.container` (600px), `table.main` (white bg, #e9e9e9 border), `td.content-wrap` (20px padding). Every `<table>`, `<tr>`, `<td>`, `<strong>`, `<a>`, `<div>` carries the full `font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;` base style. Footer with `{{baseScope.brand_name}}`.

- [ ] **Step 1: Create welcome.html**

```html
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html lang="en" xmlns="http://www.w3.org/1999/xhtml"
  style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">

<head>
  <meta name="viewport" content="width=device-width" />
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <title>Welcome</title>
</head>

<body itemscope itemtype="http://schema.org/EmailMessage"
  style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; -webkit-font-smoothing: antialiased; -webkit-text-size-adjust: none; width: 100% !important; height: 100%; line-height: 1.6em; background-color: #f6f6f6; margin: 0;"
  bgcolor="#f6f6f6">

  <table class="body-wrap"
    style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; width: 100%; background-color: #f6f6f6; margin: 0;"
    bgcolor="#f6f6f6">
    <tr
      style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
      <td
        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; vertical-align: top; margin: 0;"
        valign="top"></td>
      <td class="container" width="600"
        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; vertical-align: top; display: block !important; max-width: 600px !important; clear: both !important; margin: 0 auto;"
        valign="top">
        <div class="content"
          style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; max-width: 600px; display: block; margin: 0 auto; padding: 20px;">
          <table class="main" width="100%" cellpadding="0" cellspacing="0"
            style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; border-radius: 3px; background-color: #fff; margin: 0; border: 1px solid #e9e9e9;"
            bgcolor="#fff">
            <tr
              style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
              <td class="content-wrap"
                style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; vertical-align: top; margin: 0; padding: 20px;"
                valign="top">
                <table width="100%" cellpadding="0" cellspacing="0"
                  style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
                  <tr
                    style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
                    <td class="content-block"
                      style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; vertical-align: top; margin: 0;"
                      valign="top">
                      <strong
                        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">Bem-vindo ao {{baseScope.brand_name}}, {{user.firstname}}!</strong>
                      <br><br> Sua conta foi verificada com sucesso. Estamos felizes em te ter por aqui!
                      <br><br> Voce tem um periodo de teste gratuito de 14 dias com acesso a todos os recursos Pro.
                      <br><br> <a href="{{loginUrl}}"
                        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; color: #FFF; text-decoration: none; background-color: #1e88e5; border: solid #1e88e5; border-width: 10px 20px; line-height: 2em; font-weight: bold; text-align: center; display: inline-block; border-radius: 5px; margin: 0;">Acessar Dashboard</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
          <div class="footer"
            style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; width: 100%; clear: both; color: #999; margin: 0; padding: 20px;">
            <table width="100%"
              style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
              <tr
                style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
                <td class="aligncenter content-block"
                  style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 12px; vertical-align: top; color: #999; text-align: center; margin: 0;"
                  align="center" valign="top">
                  {{baseScope.brand_name}}
                </td>
              </tr>
            </table>
          </div>
        </div>
      </td>
      <td
        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; vertical-align: top; margin: 0;"
        valign="top"></td>
    </tr>
  </table>
</body>
</html>
```

- [ ] **Step 2: Create paymentConfirmed.html**

```html
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html lang="en" xmlns="http://www.w3.org/1999/xhtml"
  style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">

<head>
  <meta name="viewport" content="width=device-width" />
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <title>Payment Confirmed</title>
</head>

<body itemscope itemtype="http://schema.org/EmailMessage"
  style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; -webkit-font-smoothing: antialiased; -webkit-text-size-adjust: none; width: 100% !important; height: 100%; line-height: 1.6em; background-color: #f6f6f6; margin: 0;"
  bgcolor="#f6f6f6">

  <table class="body-wrap"
    style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; width: 100%; background-color: #f6f6f6; margin: 0;"
    bgcolor="#f6f6f6">
    <tr
      style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
      <td
        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; vertical-align: top; margin: 0;"
        valign="top"></td>
      <td class="container" width="600"
        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; vertical-align: top; display: block !important; max-width: 600px !important; clear: both !important; margin: 0 auto;"
        valign="top">
        <div class="content"
          style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; max-width: 600px; display: block; margin: 0 auto; padding: 20px;">
          <table class="main" width="100%" cellpadding="0" cellspacing="0"
            style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; border-radius: 3px; background-color: #fff; margin: 0; border: 1px solid #e9e9e9;"
            bgcolor="#fff">
            <tr
              style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
              <td class="content-wrap"
                style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; vertical-align: top; margin: 0; padding: 20px;"
                valign="top">
                <table width="100%" cellpadding="0" cellspacing="0"
                  style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
                  <tr
                    style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
                    <td class="content-block"
                      style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; vertical-align: top; margin: 0;"
                      valign="top">
                      <strong
                        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">Pagamento confirmado!</strong>
                      <br><br> Ola {{user.firstname}},
                      <br><br> Recebemos seu pagamento para o projeto <strong
                        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">{{projectName}}</strong>.
                      <br><br> <strong
                        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">Plano:</strong> {{planName}}<br/>
                      <strong
                        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">Valor:</strong> R$ {{amount}}<br/>
                      <strong
                        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">Periodo:</strong> {{billingPeriod}}
                      <br><br> Obrigado por escolher o {{baseScope.brand_name}}!
                      <br><br> <a href="{{projectUrl}}"
                        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; color: #FFF; text-decoration: none; background-color: #4caf50; border: solid #4caf50; border-width: 10px 20px; line-height: 2em; font-weight: bold; text-align: center; display: inline-block; border-radius: 5px; margin: 0;">Acessar projeto</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
          <div class="footer"
            style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; width: 100%; clear: both; color: #999; margin: 0; padding: 20px;">
            <table width="100%"
              style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
              <tr
                style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
                <td class="aligncenter content-block"
                  style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 12px; vertical-align: top; color: #999; text-align: center; margin: 0;"
                  align="center" valign="top">
                  {{baseScope.brand_name}}
                </td>
              </tr>
            </table>
          </div>
        </div>
      </td>
      <td
        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; vertical-align: top; margin: 0;"
        valign="top"></td>
    </tr>
  </table>
</body>
</html>
```

- [ ] **Step 3: Create trialExpiring.html**

```html
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html lang="en" xmlns="http://www.w3.org/1999/xhtml"
  style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">

<head>
  <meta name="viewport" content="width=device-width" />
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <title>Trial Expiring</title>
</head>

<body itemscope itemtype="http://schema.org/EmailMessage"
  style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; -webkit-font-smoothing: antialiased; -webkit-text-size-adjust: none; width: 100% !important; height: 100%; line-height: 1.6em; background-color: #f6f6f6; margin: 0;"
  bgcolor="#f6f6f6">

  <table class="body-wrap"
    style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; width: 100%; background-color: #f6f6f6; margin: 0;"
    bgcolor="#f6f6f6">
    <tr
      style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
      <td
        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; vertical-align: top; margin: 0;"
        valign="top"></td>
      <td class="container" width="600"
        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; vertical-align: top; display: block !important; max-width: 600px !important; clear: both !important; margin: 0 auto;"
        valign="top">
        <div class="content"
          style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; max-width: 600px; display: block; margin: 0 auto; padding: 20px;">
          <table class="main" width="100%" cellpadding="0" cellspacing="0"
            style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; border-radius: 3px; background-color: #fff; margin: 0; border: 1px solid #e9e9e9;"
            bgcolor="#fff">
            <tr
              style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
              <td class="content-wrap"
                style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; vertical-align: top; margin: 0; padding: 20px;"
                valign="top">
                <table width="100%" cellpadding="0" cellspacing="0"
                  style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
                  <tr
                    style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
                    <td class="content-block"
                      style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; vertical-align: top; margin: 0;"
                      valign="top">
                      <strong
                        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">Seu periodo de teste esta acabando</strong>
                      <br><br> Ola {{user.firstname}},
                      <br><br> Restam <strong
                        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">{{daysLeft}} dias</strong> do periodo de teste Pro do projeto <strong
                        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">{{projectName}}</strong>.
                      <br><br> Escolha um plano para continuar com todos os recursos premium.
                      <br><br> <a href="{{pricingUrl}}"
                        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; color: #FFF; text-decoration: none; background-color: #ff9800; border: solid #ff9800; border-width: 10px 20px; line-height: 2em; font-weight: bold; text-align: center; display: inline-block; border-radius: 5px; margin: 0;">Ver planos</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
          <div class="footer"
            style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; width: 100%; clear: both; color: #999; margin: 0; padding: 20px;">
            <table width="100%"
              style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
              <tr
                style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
                <td class="aligncenter content-block"
                  style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 12px; vertical-align: top; color: #999; text-align: center; margin: 0;"
                  align="center" valign="top">
                  {{baseScope.brand_name}}
                </td>
              </tr>
            </table>
          </div>
        </div>
      </td>
      <td
        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; vertical-align: top; margin: 0;"
        valign="top"></td>
    </tr>
  </table>
</body>
</html>
```

- [ ] **Step 4: Create trialExpired.html**

```html
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html lang="en" xmlns="http://www.w3.org/1999/xhtml"
  style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">

<head>
  <meta name="viewport" content="width=device-width" />
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <title>Trial Expired</title>
</head>

<body itemscope itemtype="http://schema.org/EmailMessage"
  style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; -webkit-font-smoothing: antialiased; -webkit-text-size-adjust: none; width: 100% !important; height: 100%; line-height: 1.6em; background-color: #f6f6f6; margin: 0;"
  bgcolor="#f6f6f6">

  <table class="body-wrap"
    style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; width: 100%; background-color: #f6f6f6; margin: 0;"
    bgcolor="#f6f6f6">
    <tr
      style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
      <td
        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; vertical-align: top; margin: 0;"
        valign="top"></td>
      <td class="container" width="600"
        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; vertical-align: top; display: block !important; max-width: 600px !important; clear: both !important; margin: 0 auto;"
        valign="top">
        <div class="content"
          style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; max-width: 600px; display: block; margin: 0 auto; padding: 20px;">
          <table class="main" width="100%" cellpadding="0" cellspacing="0"
            style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; border-radius: 3px; background-color: #fff; margin: 0; border: 1px solid #e9e9e9;"
            bgcolor="#fff">
            <tr
              style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
              <td class="content-wrap"
                style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; vertical-align: top; margin: 0; padding: 20px;"
                valign="top">
                <table width="100%" cellpadding="0" cellspacing="0"
                  style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
                  <tr
                    style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
                    <td class="content-block"
                      style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; vertical-align: top; margin: 0;"
                      valign="top">
                      <strong
                        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">Seu periodo de teste expirou</strong>
                      <br><br> Ola {{user.firstname}},
                      <br><br> O periodo de teste do projeto <strong
                        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">{{projectName}}</strong> expirou. Seu plano foi alterado para Iniciante (gratuito).
                      <br><br> Para recuperar os recursos Pro, escolha um plano pago.
                      <br><br> <a href="{{pricingUrl}}"
                        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; color: #FFF; text-decoration: none; background-color: #1e88e5; border: solid #1e88e5; border-width: 10px 20px; line-height: 2em; font-weight: bold; text-align: center; display: inline-block; border-radius: 5px; margin: 0;">Fazer upgrade</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
          <div class="footer"
            style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; width: 100%; clear: both; color: #999; margin: 0; padding: 20px;">
            <table width="100%"
              style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
              <tr
                style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
                <td class="aligncenter content-block"
                  style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 12px; vertical-align: top; color: #999; text-align: center; margin: 0;"
                  align="center" valign="top">
                  {{baseScope.brand_name}}
                </td>
              </tr>
            </table>
          </div>
        </div>
      </td>
      <td
        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; vertical-align: top; margin: 0;"
        valign="top"></td>
    </tr>
  </table>
</body>
</html>
```

- [ ] **Step 5: Create planCanceled.html**

```html
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html lang="en" xmlns="http://www.w3.org/1999/xhtml"
  style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">

<head>
  <meta name="viewport" content="width=device-width" />
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <title>Plan Canceled</title>
</head>

<body itemscope itemtype="http://schema.org/EmailMessage"
  style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; -webkit-font-smoothing: antialiased; -webkit-text-size-adjust: none; width: 100% !important; height: 100%; line-height: 1.6em; background-color: #f6f6f6; margin: 0;"
  bgcolor="#f6f6f6">

  <table class="body-wrap"
    style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; width: 100%; background-color: #f6f6f6; margin: 0;"
    bgcolor="#f6f6f6">
    <tr
      style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
      <td
        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; vertical-align: top; margin: 0;"
        valign="top"></td>
      <td class="container" width="600"
        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; vertical-align: top; display: block !important; max-width: 600px !important; clear: both !important; margin: 0 auto;"
        valign="top">
        <div class="content"
          style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; max-width: 600px; display: block; margin: 0 auto; padding: 20px;">
          <table class="main" width="100%" cellpadding="0" cellspacing="0"
            style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; border-radius: 3px; background-color: #fff; margin: 0; border: 1px solid #e9e9e9;"
            bgcolor="#fff">
            <tr
              style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
              <td class="content-wrap"
                style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; vertical-align: top; margin: 0; padding: 20px;"
                valign="top">
                <table width="100%" cellpadding="0" cellspacing="0"
                  style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
                  <tr
                    style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
                    <td class="content-block"
                      style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; vertical-align: top; margin: 0;"
                      valign="top">
                      <strong
                        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">Assinatura cancelada</strong>
                      <br><br> Ola {{user.firstname}},
                      <br><br> A assinatura do projeto <strong
                        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">{{projectName}}</strong> foi cancelada. Seu plano foi alterado para Iniciante (gratuito).
                      <br><br> Voce pode assinar novamente a qualquer momento.
                      <br><br> <a href="{{pricingUrl}}"
                        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; color: #FFF; text-decoration: none; background-color: #1e88e5; border: solid #1e88e5; border-width: 10px 20px; line-height: 2em; font-weight: bold; text-align: center; display: inline-block; border-radius: 5px; margin: 0;">Ver planos</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
          <div class="footer"
            style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; width: 100%; clear: both; color: #999; margin: 0; padding: 20px;">
            <table width="100%"
              style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
              <tr
                style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; margin: 0;">
                <td class="aligncenter content-block"
                  style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 12px; vertical-align: top; color: #999; text-align: center; margin: 0;"
                  align="center" valign="top">
                  {{baseScope.brand_name}}
                </td>
              </tr>
            </table>
          </div>
        </div>
      </td>
      <td
        style="font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; box-sizing: border-box; font-size: 14px; vertical-align: top; margin: 0;"
        valign="top"></td>
    </tr>
  </table>
</body>
</html>
```

- [ ] **Step 6: Commit**

```bash
git add template/email/welcome.html template/email/paymentConfirmed.html template/email/trialExpiring.html template/email/trialExpired.html template/email/planCanceled.html
git commit -m "feat: create 5 transactional email templates"
```

---

### Task 2: Add 5 send methods to emailService.js

**Files:**
- Modify: `C:\Users\enzo\tiledesk-server\services\emailService.js`

Each method follows the exact pattern of `sendVerifyEmailAddress`: readTemplate → handlebars.compile → build replacements with baseScope → template(replacements) → send({to, subject, html}).

- [ ] **Step 1: Add all 5 methods at the end of the class (before the closing bracket)**

Add these methods to `emailService.js`:

```javascript
  async sendWelcomeEmail(to, user) {
    var that = this;
    if (user.toJSON) { user = user.toJSON(); }
    var html = await this.readTemplate('welcome.html', undefined, 'EMAIL_WELCOME_HTML_TEMPLATE');
    var template = handlebars.compile(html);
    var baseScope = JSON.parse(JSON.stringify(that));
    delete baseScope.pass;
    var replacements = {
      user: user,
      baseScope: baseScope,
      loginUrl: baseScope.baseUrl + '/#/login'
    };
    var compiled = template(replacements);
    that.send({ to: to, subject: '[' + this.brand_name + '] Bem-vindo!', html: compiled });
  }

  async sendPaymentConfirmedEmail(to, user, projectName, planName, amount, billingPeriod) {
    var that = this;
    if (user.toJSON) { user = user.toJSON(); }
    var html = await this.readTemplate('paymentConfirmed.html', undefined, 'EMAIL_PAYMENT_CONFIRMED_HTML_TEMPLATE');
    var template = handlebars.compile(html);
    var baseScope = JSON.parse(JSON.stringify(that));
    delete baseScope.pass;
    var replacements = {
      user: user,
      baseScope: baseScope,
      projectName: projectName,
      planName: planName,
      amount: amount,
      billingPeriod: billingPeriod === 'annual' ? 'Anual' : 'Mensal',
      projectUrl: baseScope.baseUrl
    };
    var compiled = template(replacements);
    that.send({ to: to, subject: '[' + this.brand_name + '] Pagamento confirmado - ' + planName, html: compiled });
  }

  async sendTrialExpiringEmail(to, user, projectName, daysLeft) {
    var that = this;
    if (user.toJSON) { user = user.toJSON(); }
    var html = await this.readTemplate('trialExpiring.html', undefined, 'EMAIL_TRIAL_EXPIRING_HTML_TEMPLATE');
    var template = handlebars.compile(html);
    var baseScope = JSON.parse(JSON.stringify(that));
    delete baseScope.pass;
    var replacements = {
      user: user,
      baseScope: baseScope,
      projectName: projectName,
      daysLeft: daysLeft,
      pricingUrl: baseScope.baseUrl
    };
    var compiled = template(replacements);
    that.send({ to: to, subject: '[' + this.brand_name + '] Seu periodo de teste expira em ' + daysLeft + ' dias', html: compiled });
  }

  async sendTrialExpiredEmail(to, user, projectName) {
    var that = this;
    if (user.toJSON) { user = user.toJSON(); }
    var html = await this.readTemplate('trialExpired.html', undefined, 'EMAIL_TRIAL_EXPIRED_HTML_TEMPLATE');
    var template = handlebars.compile(html);
    var baseScope = JSON.parse(JSON.stringify(that));
    delete baseScope.pass;
    var replacements = {
      user: user,
      baseScope: baseScope,
      projectName: projectName,
      pricingUrl: baseScope.baseUrl
    };
    var compiled = template(replacements);
    that.send({ to: to, subject: '[' + this.brand_name + '] Seu periodo de teste expirou', html: compiled });
  }

  async sendPlanCanceledEmail(to, user, projectName) {
    var that = this;
    if (user.toJSON) { user = user.toJSON(); }
    var html = await this.readTemplate('planCanceled.html', undefined, 'EMAIL_PLAN_CANCELED_HTML_TEMPLATE');
    var template = handlebars.compile(html);
    var baseScope = JSON.parse(JSON.stringify(that));
    delete baseScope.pass;
    var replacements = {
      user: user,
      baseScope: baseScope,
      projectName: projectName,
      pricingUrl: baseScope.baseUrl
    };
    var compiled = template(replacements);
    that.send({ to: to, subject: '[' + this.brand_name + '] Assinatura cancelada', html: compiled });
  }
```

- [ ] **Step 2: Verify syntax**

```bash
node --check services/emailService.js
```

- [ ] **Step 3: Commit**

```bash
git add services/emailService.js
git commit -m "feat: add 5 transactional email methods to emailService"
```

---

### Task 3: Add deduplication flags to profile.js

**Files:**
- Modify: `C:\Users\enzo\tiledesk-server\models\profile.js`

- [ ] **Step 1: Add trialExpiringNotified and trialExpiredNotified fields**

In `models/profile.js`, after the `billingPeriod` field (added earlier), add:

```javascript
  trialExpiringNotified: {
    type: Boolean,
  },
  trialExpiredNotified: {
    type: Boolean,
  },
```

- [ ] **Step 2: Verify syntax**

```bash
node --check models/profile.js
```

- [ ] **Step 3: Commit**

```bash
git add models/profile.js
git commit -m "feat: add trialExpiringNotified and trialExpiredNotified to profile schema"
```

---

### Task 4: Trigger welcome email after email verification

**Files:**
- Modify: `C:\Users\enzo\tiledesk-server\routes\auth.js`

The welcome email must be sent AFTER the user has verified their email, not on signup. The verification endpoint is `PUT /verifyemail/:userid/:code` (around line 875 of `routes/auth.js`). After the `User.findByIdAndUpdate` succeeds and the user is confirmed, we send the welcome email.

- [ ] **Step 1: Add welcome email call inside the verifyemail endpoint**

In `routes/auth.js`, find the `PUT /verifyemail/:userid/:code` handler. Inside the `User.findByIdAndUpdate` callback, after the `findUser` validation checks succeed and before `res.json(findUser)` (around line 914), add:

```javascript
    emailService.sendWelcomeEmail(findUser.email, findUser);
```

The full context of the change (lines ~900-915):

```javascript
  User.findByIdAndUpdate(user_id, req.body, { new: true, upsert: true }, function (err, findUser) {
    if (err) {
      winston.error(err);
      return res.status(500).send({ success: false, msg: err });
    }
    winston.debug(findUser);
    if (!findUser) {
      winston.warn('User not found for verifyemail' );
      return res.status(404).send({ success: false, msg: 'User not found', error_code: errorCodes.AUTH.ERRORS.USER_NOT_FOUND});
    }
    winston.debug('VERIFY EMAIL - RETURNED USER ', findUser);

    emailService.sendWelcomeEmail(findUser.email, findUser);

    res.json(findUser);
  });
```

Note: `emailService` is already imported at the top of `auth.js` (line 10), so no new import is needed. The welcome email fires only once because verification only happens once per user.

- [ ] **Step 2: Verify syntax**

```bash
node --check routes/auth.js
```

- [ ] **Step 3: Commit**

```bash
git add routes/auth.js
git commit -m "feat: trigger welcome email after email verification"
```

---

### Task 5: Trigger payment confirmed and plan canceled emails

**Files:**
- Modify: `C:\Users\enzo\tiledesk-server\pubmodules\billing\index.js`

- [ ] **Step 1: Add emailService import at the top**

After the existing requires (around line 12), add:

```javascript
var emailService = require('../../services/emailService');
```

- [ ] **Step 2: Add payment confirmed email in webhook AUTHORIZED block**

In the webhook handler, inside the `payment_request/updated` block where status is AUTHORIZED/active, after the `Project.findByIdAndUpdate` call (where the plan is applied), add:

```javascript
        var ownerPU = await Project_user.findOne({ id_project: project._id, role: 'owner', status: 'active' });
        if (ownerPU) {
          var owner = await User.findById(ownerPU.id_user);
          if (owner && owner.email) {
            var displayName = plan.displayName || plan.name;
            emailService.sendPaymentConfirmedEmail(owner.email, owner, project.name, displayName, amount, project.profile.billingPeriod || 'monthly');
          }
        }
```

- [ ] **Step 3: Add plan canceled email in cancel handler**

In the cancel handler, after the `Project.findByIdAndUpdate` that downgrades to Free, add:

```javascript
      var ownerPU = await Project_user.findOne({ id_project: projectId, role: 'owner', status: 'active' });
      if (ownerPU) {
        var owner = await User.findById(ownerPU.id_user);
        if (owner && owner.email) {
          emailService.sendPlanCanceledEmail(owner.email, owner, project.name);
        }
      }
```

- [ ] **Step 4: Verify syntax**

```bash
node --check pubmodules/billing/index.js
```

- [ ] **Step 5: Commit**

```bash
git add pubmodules/billing/index.js
git commit -m "feat: trigger payment confirmed and plan canceled emails"
```

---

### Task 6: Trigger trial expired email in middleware

**Files:**
- Modify: `C:\Users\enzo\tiledesk-server\middleware\trial-expiration.js`

- [ ] **Step 1: Add imports at the top**

After the existing requires, add:

```javascript
var Project_user = require('../models/project_user');
var User = require('../models/user');
var emailService = require('../services/emailService');
```

- [ ] **Step 2: Add email sending inside the .then() block after downgrade**

Inside the `.then(function(updatedProject))` block, after `winston.info('Trial expired...')` and before `req.project = updatedProject`, add:

```javascript
      if (updatedProject && !updatedProject.profile.trialExpiredNotified) {
        Project.findByIdAndUpdate(req.project._id, { $set: { 'profile.trialExpiredNotified': true } }).catch(function() {});
        Project_user.findOne({ id_project: req.project._id, role: 'owner', status: 'active' }).then(function(ownerPU) {
          if (ownerPU) {
            User.findById(ownerPU.id_user).then(function(owner) {
              if (owner && owner.email) {
                emailService.sendTrialExpiredEmail(owner.email, owner, req.project.name);
              }
            }).catch(function() {});
          }
        }).catch(function() {});
      }
```

Note: Uses .then() callbacks (not async/await) to match the middleware's existing callback style. Email sending is fire-and-forget — errors are silently caught.

- [ ] **Step 3: Verify syntax**

```bash
node --check middleware/trial-expiration.js
```

- [ ] **Step 4: Commit**

```bash
git add middleware/trial-expiration.js
git commit -m "feat: trigger trial expired email with deduplication flag"
```

---

### Task 7: Create trial expiring cron task

**Files:**
- Create: `C:\Users\enzo\tiledesk-server\pubmodules\scheduler\tasks\trialExpiringNotificationTask.js`
- Modify: `C:\Users\enzo\tiledesk-server\pubmodules\scheduler\taskRunner.js`

- [ ] **Step 1: Create the cron task**

```javascript
const schedule = require('node-schedule');
const winston = require('../../../config/winston');
const Project = require('../../../models/project');
const Project_user = require('../../../models/project_user');
const User = require('../../../models/user');
const emailService = require('../../../services/emailService');

class TrialExpiringNotificationTask {

  constructor() {
    this.enabled = process.env.TRIAL_EXPIRING_NOTIFICATION_ENABLED || 'true';
    this.cronExp = process.env.TRIAL_EXPIRING_NOTIFICATION_CRON || '0 9 * * *';
    this.daysBeforeExpiry = parseInt(process.env.TRIAL_EXPIRING_NOTIFICATION_DAYS) || 3;
  }

  run() {
    if (this.enabled === 'true') {
      winston.info('TrialExpiringNotificationTask started with cron: ' + this.cronExp);
      this.scheduleTask();
    } else {
      winston.info('TrialExpiringNotificationTask disabled');
    }
  }

  scheduleTask() {
    var that = this;
    schedule.scheduleJob(this.cronExp, function () {
      winston.info('TrialExpiringNotificationTask running...');
      that.findExpiringTrials();
    });
  }

  async findExpiringTrials() {
    try {
      var projects = await Project.find({
        'profile.type': 'free',
        'profile.trialDays': { $exists: true },
        'profile.trialExpiringNotified': { $ne: true }
      }).lean();

      var now = new Date();
      var notified = 0;

      for (var i = 0; i < projects.length; i++) {
        var project = projects[i];
        var trialDays = project.profile.trialDays || 14;
        var createdAt = new Date(project.createdAt);
        var expiresAt = new Date(createdAt.getTime() + trialDays * 24 * 60 * 60 * 1000);
        var daysLeft = Math.ceil((expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

        if (daysLeft === this.daysBeforeExpiry) {
          try {
            var ownerPU = await Project_user.findOne({ id_project: project._id, role: 'owner', status: 'active' });
            if (ownerPU) {
              var owner = await User.findById(ownerPU.id_user);
              if (owner && owner.email) {
                emailService.sendTrialExpiringEmail(owner.email, owner, project.name, daysLeft);
                await Project.findByIdAndUpdate(project._id, { $set: { 'profile.trialExpiringNotified': true } });
                notified++;
                winston.info('TrialExpiringNotificationTask: notified ' + owner.email + ' for project ' + project.name);
              }
            }
          } catch (err) {
            winston.error('TrialExpiringNotificationTask: error processing project ' + project._id, err);
          }
        }
      }

      winston.info('TrialExpiringNotificationTask: ' + notified + ' notifications sent');
    } catch (err) {
      winston.error('TrialExpiringNotificationTask error', err);
    }
  }
}

var task = new TrialExpiringNotificationTask();
module.exports = task;
```

- [ ] **Step 2: Register in taskRunner.js**

Add require at top:
```javascript
var trialExpiringNotificationTask = require('./tasks/trialExpiringNotificationTask');
```

Add in `start()` method, after existing task runs:
```javascript
      trialExpiringNotificationTask.run();
```

- [ ] **Step 3: Verify syntax**

```bash
node --check pubmodules/scheduler/tasks/trialExpiringNotificationTask.js
node --check pubmodules/scheduler/taskRunner.js
```

- [ ] **Step 4: Commit**

```bash
git add pubmodules/scheduler/tasks/trialExpiringNotificationTask.js pubmodules/scheduler/taskRunner.js
git commit -m "feat: cron task for trial expiring email notifications (daily at 9am)"
```

---

## Self-Review

### Spec Coverage

| Spec Requirement | Task | Covered? |
|---|---|---|
| welcome.html template | Task 1 Step 1 | ✅ |
| paymentConfirmed.html template | Task 1 Step 2 | ✅ |
| trialExpiring.html template | Task 1 Step 3 | ✅ |
| trialExpired.html template | Task 1 Step 4 | ✅ |
| planCanceled.html template | Task 1 Step 5 | ✅ |
| sendWelcomeEmail method | Task 2 | ✅ |
| sendPaymentConfirmedEmail method | Task 2 | ✅ |
| sendTrialExpiringEmail method | Task 2 | ✅ |
| sendTrialExpiredEmail method | Task 2 | ✅ |
| sendPlanCanceledEmail method | Task 2 | ✅ |
| trialExpiringNotified flag | Task 3 | ✅ |
| trialExpiredNotified flag | Task 3 | ✅ |
| Welcome trigger in auth.js verifyemail endpoint | Task 4 | ✅ |
| Payment trigger in billing webhook | Task 5 | ✅ |
| Cancel trigger in billing cancel | Task 5 | ✅ |
| Trial expired trigger in middleware | Task 6 | ✅ |
| Trial expiring cron task | Task 7 | ✅ |
| Deduplication flags | Tasks 3, 6, 7 | ✅ |
| Follows existing emailService pattern | Task 2 | ✅ |
| Follows existing cron task pattern | Task 7 | ✅ |
