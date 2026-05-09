"use strict";
const express = require("express");
const router = express.Router();
const bodyParser = require("body-parser");
const appRoot = require("app-root-path");
const handlebars = require("handlebars");
const fs = require("fs");
const path = require("path");
const pjson = require("./package.json");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");
var winston = require("./winston");
const url = require("url");
const mongoose = require("mongoose");
const api = require("./routes/api");
const apiRoute = api.router;
const axios = require('axios').default;
const { parsePhoneNumberFromString } = require('libphonenumber-js');


// tiledesk clients
const { TiledeskClient } = require("@tiledesk/tiledesk-client");
const { TiledeskWhatsappTranslator } = require("./tiledesk/TiledeskWhatsappTranslator");
const { TiledeskSubscriptionClient } = require("./tiledesk/TiledeskSubscriptionClient");
const { TiledeskWhatsapp } = require("./tiledesk/TiledeskWhatsapp");
const { TiledeskChannel } = require("./tiledesk/TiledeskChannel");
const { TiledeskAppsClient } = require("./tiledesk/TiledeskAppsClient");
const { MessageHandler } = require("./tiledesk/MessageHandler");
const { TiledeskBotTester } = require("./tiledesk/TiledeskBotTester");
const { TemplateManager } = require("./tiledesk/TemplateManager");
const { WhatsappLogger } = require("./tiledesk/WhatsappLogger");
const Utils = require("./tiledesk/Utils");
const whatsappService = require("./tiledesk/WhatsappService");
const operationalLogger = require("../../../services/operationalLogger");

// mongo
const { KVBaseMongo } = require("./tiledesk/KVBaseMongo");
const kvbase_collection = "kvstore";
const db = new KVBaseMongo(kvbase_collection);
const utils = new Utils({db: db});

// redis
var redis = require("redis");
const { MFA_MISMATCH } = require("./meta_errors");
var redis_client;

router.use(bodyParser.json());
router.use(bodyParser.urlencoded({ extended: true }));
router.use(express.static(path.join(__dirname, "template")));
router.use(cors());
router.use("/ext", apiRoute);
router.use("/api", apiRoute);

let API_URL = null;
let GRAPH_URL = null;
let BASE_FILE_URL = null;
let BASE_URL = null;
let APPS_API_URL = null;
let REDIS_HOST = null;
let REDIS_PORT = null;
let REDIS_PASSWORD = null;
let AMQP_MANAGER_URL = null;
let JOB_TOPIC_EXCHANGE = null;
let BRAND_NAME = null;
let FB_APP_ID = null;
let CONFIGURATION_ID = null;

function getWebhookValue(body) {
  return body && body.entry && body.entry[0] && body.entry[0].changes && body.entry[0].changes[0] && body.entry[0].changes[0].value
    ? body.entry[0].changes[0].value
    : {};
}

function getWebhookMessageId(body) {
  const value = getWebhookValue(body);
  if (value.messages && value.messages[0]) return value.messages[0].id;
  if (value.statuses && value.statuses[0]) return value.statuses[0].id;
  return undefined;
}

function getWebhookKind(body) {
  const value = getWebhookValue(body);
  if (value.messages && value.messages[0]) return 'message:' + value.messages[0].type;
  if (value.statuses && value.statuses[0]) return 'status:' + value.statuses[0].status;
  return 'unknown';
}

function recordWabaOperation(settings, wabaId, event) {
  operationalLogger.recordSafe(Object.assign({
    area: 'webhook',
    channel: 'waba',
    id_project: settings && settings.project_id,
    integrationId: wabaId || (settings && (settings.waba_id || settings.phone_number_id))
  }, event));
}

// Handlebars register helpers
handlebars.registerHelper("isEqual", (a, b) => {
  if (a == b) {
    return true;
  } else {
    return false;
  }
});

handlebars.registerHelper("json", (a) => {
  return JSON.stringify(a);
});

handlebars.registerHelper('formatPhone', function (rawNumber) {
  try {
    const phone = parsePhoneNumberFromString("+" + rawNumber);
    return phone.formatInternational(); // oppure .formatNational()
  } catch(err) {
    return rawNumber;
  }
});

router.get("/", async (req, res) => {
  res.send("Welcome to Tiledesk-WhatsApp Business connector!");
});


// ***************************************
// ***** MANAGEMENT SECTION - START ******
// ***************************************
router.get("/configure", async (req, res) => {
  winston.verbose("(wab) /configure");

  let project_id = req.query.project_id;
  let token = req.query.token;

  const popup = req.query.view;
  const popup_view = popup === "popup"

  const type = req.query.type || 'oauth';
  let isOAuth = type === 'oauth';

  if (!project_id || !token) {
    let error_message = "Query params project_id and token are required.";
    return readHTMLFile("/error.html", (err, html) => {
      var template = handlebars.compile(html);

      var replacements = {
        app_version: pjson.version,
        error_message: error_message,
      };
      var html = template(replacements);
      res.send(html);
    });
  }

  let settings = await utils.getSettingsByProjectId(project_id);
  if (!settings) {
    settings = await utils.getSettings(project_id, null);
  }

  let allInstances = await utils.getAllSettingsByProjectId(project_id);

  let departments = await getDepartments(project_id, token);

  let proxy_url = BASE_URL + "/webhook/" + project_id;

  if (settings) {

    if (settings.source !== 'oauth') {
      isOAuth = false;
    }

    readHTMLFile("/configure.html", (err, html) => {
      let template = handlebars.compile(html);
      let replacements = {
        app_version: pjson.version,
        project_id: project_id,
        token: token,
        proxy_url: proxy_url,
        wab_token: settings.wab_token,
        verify_token: settings.verify_token,
        business_account_id: settings.business_account_id,
        phone_number: settings.phone_number,
        phone_number_id: settings.phone_number_id,
        waba_id: settings.waba_id,
        verified_name: settings.verified_name,
        subscription_id: settings.subscriptionId,
        department_id: settings.department_id,
        departments: departments,
        brand_name: BRAND_NAME,
        isOAuth: isOAuth,
        fb_app_id: FB_APP_ID,
        configuration_id: CONFIGURATION_ID,
        api_url: API_URL,
        all_instances: allInstances || [],
      }
      let renderedHtml = template(replacements);
      res.send(renderedHtml);
    })
    return;
  }

  readHTMLFile("/configure.html", (err, html) => {
    let template = handlebars.compile(html);
    let replacements = {
      app_version: pjson.version,
      project_id: project_id,
      token: token,
      proxy_url: proxy_url,
      departments: departments,
      popup_view: popup_view,
      brand_name: BRAND_NAME,
      isOAuth: isOAuth,
      fb_app_id: FB_APP_ID,
      configuration_id: CONFIGURATION_ID,
      api_url: API_URL,
      all_instances: allInstances || [],
    };
    let renderedHtml = template(replacements);
    res.send(renderedHtml);
  })
  return;
})

router.get('/onboarding/callback', async (req, res) => {
  const { code, waba_id, phone_number_id, business_id } = req.query;
  let state;
  try {
    state = JSON.parse(req.query.state)
  } catch(err) {
    winston.error("(wab) Error parsing query state");
    return res.status(500).send({ success: false, message: "Error parsing query state" });
  }
  const project_id = state.project_id;
  const token = state.token;

  try {

    const tdClient = new TiledeskSubscriptionClient({
      API_URL: API_URL,
      project_id: project_id,
      token: token
    })

    const subscription_info = {
      target: BASE_URL + "/tiledesk",
      event: "message.create.request.channel.whatsapp",
    }
    const subscription = await tdClient.subscribe(subscription_info);

    const data = await whatsappService.handleOnboarding(code, business_id, waba_id, phone_number_id)

    let settings = {
      source: 'oauth',
      project_id: project_id,
      token: token,
      subscriptionId: subscription._id,
      secret: REDACTED_SECRET,
      wab_token: data.access_token,
      business_account_id: data.business_account_id,
      waba_id: data.waba_id,
      phone_number_id: data.phone_number_id,
      phone_number: data.phone_number,
      verified_name: data.verified_name
    }

    let CONTENT_KEY = "whatsapp-" + waba_id;
    await db.set(CONTENT_KEY, settings);

    // Dual-write to integrations collection
    try {
      await axios.post(API_URL + '/' + settings.project_id + '/integration', {
        name: 'whatsapp',
        value: {
          phone_number_id: settings.phone_number_id,
          waba_id: settings.waba_id,
          phone_number: settings.phone_number,
          verified_name: settings.verified_name
        }
      }, {
        headers: { 'Authorization': 'JWT ' + settings.token }
      });
    } catch(intErr) {
      winston.error("(wab) Error creating integration document: " + intErr.message);
    }

    try {
      let register_result = await whatsappService.registerNumber(data.access_token, data.phone_number_id)
      winston.verbose("(wab) /onboarding/callback register_result: ", register_result)

      let connection_result = await whatsappService.connectNumber(data.access_token, data.waba_id)
      winston.verbose("(wab) /onboarding/callback connection_result: ", connection_result)
    } catch (err) {
      if (err.code === MFA_MISMATCH.CODE) {
        res.status(202).send({
          success: false,
          code: MFA_MISMATCH.CODE,
          message: "PIN Mismatch",
          settings: settings,
        })
        return;
      } else {
        winston.error("(wab) onboarding finalizing error: ", err.response?.data || err.message);
        res.status(500).send({ success: false, message: "Error during onboarding", settings: settings })
        return;
      }
    }

    res.status(200).send(settings)

  } catch (err) {
    winston.error("(wab) onboarding error: ", err.response?.data || err.message);
    res.status(500).json({ error: "Onboarding callback error: " + err });
    return;
  }
})

router.get('/onboarding/register', async (req, res) => {
  const { pin, waba_id, wab_token, phone_number_id } = req.query;

  winston.verbose("(wab) pin: ", pin, "wab_token: ", wab_token, "phone_number_id: ", phone_number_id);

  if (!wab_token || !phone_number_id || !pin) {
    res.status(400).send({
      success: false,
      message: "Missing required parameters"
    })
    return;
  }

  try {
    let register_result = await whatsappService.registerNumber(wab_token, phone_number_id, pin);
    winston.verbose("(wab) /onboarding/register register_result: ", register_result)

    let connection_result = await whatsappService.connectNumber(data.access_token, data.waba_id)
    winston.verbose("(wab) /onboarding/callback connection_result: ", connection_result)

  } catch (err) {
    winston.error("(wab) register error: ", err.response?.data || err.message);
    if (err.response?.data?.code === MFA_MISMATCH.CODE) {
      res.status(202).send({
        success: false,
        code: MFA_MISMATCH.CODE,
        message: "PIN Mismatch"
      })
      return;
    } else {
      res.status(400).send({
        success: false,
        message: "Error registering phone number"
      })
      return;
    }
  }

  res.status(200).send("Phone number registered");

})

router.put("/update/department", async (req, res) => {
  let project_id = req.query.project_id;
  let token = req.query.token;

  let department_id = req.body.department_id;
  winston.verbose("(wab) changing department with: ", department_id);

  let settings = await utils.getSettingsByProjectId(project_id);
  settings.department_id = department_id;

  let CONTENT_KEY = "whatsapp-" + settings.waba_id;
  await db.set(CONTENT_KEY, settings);

  res.status(200).send("Department Id updated")
})

router.post("/update", async (req, res) => {
  winston.verbose("(wab) /update");

  let project_id = req.body.project_id;
  let token = req.body.token;
  let wab_token = req.body.wab_token;
  let verify_token = req.body.verify_token;
  let department_id = req.body.department;
  let business_account_id = req.body.business_account_id;

  let CONTENT_KEY = "whatsapp-" + project_id;
  let settings = await db.get(CONTENT_KEY);

  let proxy_url = BASE_URL + "/webhook/" + project_id;

  // get departments
  const tdChannel = new TiledeskChannel({
    settings: { project_id: project_id, token: token },
    API_URL: API_URL,
  });
  let departments = await tdChannel.getDepartments();

  if (settings) {
    settings.wab_token = wab_token;
    settings.verify_token = verify_token;
    settings.department_id = department_id;
    settings.business_account_id = business_account_id;

    const twClient = new TiledeskWhatsapp({
      token: settings.wab_token,
      GRAPH_URL: GRAPH_URL,
      API_URL: API_URL
    });

    await twClient.getBusinessAccountInfo(business_account_id).then((info) => {
      settings.phone_number_id = info.data[0].id;
      settings.phone_number = info.data[0].display_phone_number;
      settings.verified_name = info.data[0].verified_name;
    }).catch((err) => {
      winston.error("(wab) Error getting WAB Account Info");
    })

    await db.set(CONTENT_KEY, settings);

    // Dual-write to integrations collection
    try {
      await axios.post(API_URL + '/' + project_id + '/integration', {
        name: 'whatsapp',
        value: {
          phone_number_id: settings.phone_number_id,
          waba_id: settings.business_account_id,
          phone_number: settings.phone_number,
          verified_name: settings.verified_name
        }
      }, {
        headers: { 'Authorization': 'JWT ' + token }
      });
    } catch(intErr) {
      winston.error("(wab) Error creating integration document: " + intErr.message);
    }

    readHTMLFile("/configure.html", (err, html) => {
      var template = handlebars.compile(html);
      var replacements = {
        app_version: pjson.version,
        project_id: project_id,
        token: token,
        proxy_url: proxy_url,
        wab_token: settings.wab_token,
        show_success_modal: true,
        verify_token: settings.verify_token,
        business_account_id: settings.business_account_id,
        phone_number: settings.phone_number,
        phone_number_id: settings.phone_number_id,
        verified_name: settings.verified_name,
        subscription_id: settings.subscriptionId,
        department_id: settings.department_id,
        departments: departments,
        brand_name: BRAND_NAME
      };
      var html = template(replacements);
      res.send(html);
    });
  } else {
    const tdClient = new TiledeskSubscriptionClient({
      API_URL: API_URL,
      project_id: project_id,
      token: token,
    });

    const subscription_info = {
      target: BASE_URL + "/tiledesk",
      event: "message.create.request.channel.whatsapp",
    };


    tdClient.subscribe(subscription_info).then((data) => {
      let subscription = data;
      winston.debug("\n(wab) Subscription: ", subscription);

      let settings = {
        source: 'manual',
        project_id: project_id,
        token: token,
        proxy_url: proxy_url,
        subscriptionId: subscription._id,
        secret: REDACTED_SECRET,
        wab_token: wab_token,
        verify_token: verify_token,
        business_account_id: business_account_id,
        department_id: department_id,
      };

      db.set(CONTENT_KEY, settings);
      //let cnt = db.get(CONTENT_KEY);

      readHTMLFile("/configure.html", (err, html) => {
        var template = handlebars.compile(html);
        var replacements = {
          app_version: pjson.version,
          project_id: project_id,
          token: token,
          proxy_url: proxy_url,
          show_success_modal: true,
          wab_token: settings.wab_token,
          verify_token: settings.verify_token,
          business_account_id: settings.business_account_id,
          phone_number: settings.phone_number,
          phone_number_id: settings.phone_number_id,
          verified_name: settings.verified_name,
          subscription_id: settings.subscriptionId,
          department_id: settings.department_id,
          departments: departments,
          brand_name: BRAND_NAME
        };
        var html = template(replacements);
        res.send(html);
      });
    }).catch((err) => {
      readHTMLFile("/configure.html", (err, html) => {
        var template = handlebars.compile(html);
        var replacements = {
          app_version: pjson.version,
          project_id: project_id,
          token: token,
          proxy_url: proxy_url,
          departments: departments,
          show_error_modal: true,
          brand_name: BRAND_NAME
        };
        var html = template(replacements);
        res.send(html);
      });
    });
  }
});

router.post("/getinfo", async (req, res) => {

  winston.verbose("(wab) /getinfo");
  let project_id = req.body.project_id;
  let token = req.body.token;
  let proxy_url = BASE_URL + "/webhook/" + project_id;

  let CONTENT_KEY = "whatsapp-" + project_id;
  let settings = await db.get(CONTENT_KEY);

  const tdChannel = new TiledeskChannel({
    settings: { project_id: project_id, token: token },
    API_URL: API_URL,
  });
  let departments = await tdChannel.getDepartments();

  const twClient = new TiledeskWhatsapp({
    token: settings.wab_token,
    GRAPH_URL: GRAPH_URL,
    API_URL: API_URL
  });

  await twClient.getBusinessAccountInfo(settings.business_account_id).then((info) => {
    settings.phone_number_id = info.data[0].id;
    settings.phone_number = info.data[0].display_phone_number;
    settings.verified_name = info.data[0].verified_name;
    winston.debug("(wab) Business account info: ", info);
  }).catch((err) => {
    winston.error("(wab) Error getting WAB Account Info");
  })

  await db.set(CONTENT_KEY, settings);

  readHTMLFile("/configure.html", (err, html) => {
    var template = handlebars.compile(html);
    var replacements = {
      app_version: pjson.version,
      project_id: project_id,
      token: token,
      proxy_url: proxy_url,
      wab_token: settings.wab_token,
      show_success_modal: true,
      verify_token: settings.verify_token,
      business_account_id: settings.business_account_id,
      phone_number: settings.phone_number,
      phone_number_id: settings.phone_number_id,
      verified_name: settings.verified_name,
      subscription_id: settings.subscriptionId,
      department_id: settings.department_id,
      departments: departments,
      brand_name: BRAND_NAME
    };
    var html = template(replacements);
    res.send(html);
  });

})

router.post("/disconnect", async (req, res) => {
  winston.verbose("(wab) /disconnect");

  let project_id = req.body.project_id;
  let token = req.body.token;
  let subscriptionId = req.body.subscription_id;
  let waba_id = req.body.waba_id;

  let deleted;
  if (waba_id) {
    deleted = await db.remove('whatsapp-' + waba_id);
  } else {
    deleted = await utils.deleteSettingsByProjectId(project_id);
    if (!deleted) {
      deleted = utils.deleteSettings(project_id, null)
    }
  }

  if (waba_id) {
    try {
      let response = await axios.get(API_URL + '/' + project_id + '/integration/name/whatsapp/instances', {
        headers: { 'Authorization': 'JWT ' + token }
      });
      if (response.data && Array.isArray(response.data)) {
        let toDelete = response.data.find(function(i) { return i.value && i.value.waba_id === waba_id; });
        if (toDelete) {
          await axios.delete(API_URL + '/' + project_id + '/integration/' + toDelete._id, {
            headers: { 'Authorization': 'JWT ' + token }
          });
        }
      }
    } catch(delErr) {
      winston.error("(wab) Error deleting integration: " + delErr.message);
    }
  }

  if (!deleted) {
    let error_message = "Unable to disconnect WhatsApp";
    return readHTMLFile("/error.html", (err, html) => {
      let template = handlebars.compile(html);
      let replacements = {
        app_version: pjson.version,
        error_message: error_message,
      };
      let renderedHtml = template(replacements);
      res.send(renderedHtml);
    });
  }

  const tdClient = new TiledeskSubscriptionClient({
    API_URL: API_URL,
    project_id: project_id,
    token: token,
  });

  tdClient.unsubscribe(subscriptionId).then((data) => {
    res.redirect(`configure?project_id=${project_id}&token=${token}`);
  }).catch((err) => {
    winston.error("(wab) unsubscribe error: " + err);
  });
});
// ***************************************
// ****** MANAGEMENT SECTION - END *******
// ***************************************

// ---------------------------------------

// ***************************************
// ****** MESSAGING SECTION - START ******
// ***************************************
router.post("/tiledesk", async (req, res) => {
  winston.verbose("(wab) Message received from Tiledesk");

  let tiledeskChannelMessage = req.body.payload;
  winston.debug("(wab) tiledeskChannelMessage: ", tiledeskChannelMessage);

  let project_id = req.body.payload.id_project;
  let recipient = req.body.payload.recipient;
  let waba_id = recipient.split('-')[5];

  let phone_number_id_from_attrs = null;
  if (req.body.payload.attributes && req.body.payload.attributes.whatsapp_phone_number_id) {
    phone_number_id_from_attrs = req.body.payload.attributes.whatsapp_phone_number_id;
  }
  let settings;
  if (phone_number_id_from_attrs) {
    settings = await utils.getSettingsByPhoneNumberId(phone_number_id_from_attrs);
  }
  if (!settings) {
    settings = await utils.getSettingsByProjectId(project_id);
  }
  if (!settings) {
    settings = await utils.getSettings(project_id, waba_id);
  }

  if (!settings) {
    winston.error("(wab) No WhatsApp settings found for project " + project_id);
    return res.status(404).json({ error: "WhatsApp settings not found" });
  }

  let wab_token = settings.wab_token;

  var text = req.body.payload.text;
  let attributes = req.body.payload.attributes;
  let commands;
  if (attributes && attributes.commands) {
    commands = attributes.commands;
  }

  var sender_id = req.body.payload.sender;

  if (sender_id.indexOf("wab") > -1) {
    winston.verbose("(wab) Skip same sender");
    return res.sendStatus(200);
  }

  if (attributes && attributes.subtype === "info") {
    winston.verbose("(wab) Skip subtype (info)");
    return res.sendStatus(200);
  }

  if (attributes && attributes.subtype === "private") {
    winston.verbose("(wab) Skip subtype (private)");
    return res.sendStatus(200);
  }

  if (attributes && attributes.subtype === "info/support") {
    winston.verbose("(wab) Skip subtype: " + attributes.subtype);
    return res.sendStatus(200);
  }

  let recipient_id = tiledeskChannelMessage.recipient;
  let sender = tiledeskChannelMessage.sender;
  let whatsapp_receiver = recipient_id.substring(recipient_id.lastIndexOf("-") + 1);

  let phone_number_id;
  if (attributes && attributes.whatsapp_phone_number_id) {
    phone_number_id = attributes.whatsapp_phone_number_id;
  } else {
    phone_number_id = recipient_id.substring(recipient_id.lastIndexOf("wab-") + 4, recipient_id.lastIndexOf("-"));
  }

  if (!phone_number_id) {
    return res.status(400).send({ success: false, message: "Phone number id undefined" });
  }

  // Return an info message option
  if (settings.expired && settings.expired === true) {
    winston.verbose("(wab) settings expired: " + settings.expired);
    let tiledeskJsonMessage = {
      text: "Expired. Upgrade Plan.",
      sender: "system",
      senderFullname: "System",
      attributes: {
        subtype: "info",
      },
      channel: { name: "whatsapp" },
    };
    let message_info = {
      channel: "whatsapp",
      whatsapp: {
        from: whatsapp_receiver,
        phone_number_id: phone_number_id,
        waba_id: waba_id
      },
    };

    const tdChannel = new TiledeskChannel({
      settings: settings,
      API_URL: API_URL,
    });
    const response = await tdChannel.send(
      tiledeskJsonMessage,
      message_info,
      settings.department_id
    );
    winston.verbose("(wab) Expiration message sent to Tiledesk");
    return res.sendStatus(200);
  }

  winston.debug("(wab) text: " + text);
  winston.debug("(wab) attributes: " + attributes);
  winston.debug("(wab) tiledesk sender_id: " + sender_id);
  winston.debug("(wab) recipient_id: " + recipient_id);
  winston.debug("(wab) whatsapp_receiver: " + whatsapp_receiver);
  winston.debug("(wab) phone_number_id: " + phone_number_id);

  const messageHandler = new MessageHandler({
    tiledeskChannelMessage: tiledeskChannelMessage,
  });
  const tlr = new TiledeskWhatsappTranslator();

  if (commands && commands.length > 0) {
    let i = 0;
    async function execute(command) {
      // message
      if (command.type === "message") {
        let tiledeskCommandMessage = await messageHandler.generateMessageObject(
          command
        );
        winston.debug("(wab) message generated from command: ", tiledeskCommandMessage);

        let whatsappJsonMessage = await tlr.toWhatsapp(tiledeskCommandMessage, whatsapp_receiver);
        winston.verbose("(wab) whatsappJsonMessage", whatsappJsonMessage);

        if (whatsappJsonMessage) {
          const twClient = new TiledeskWhatsapp({
            token: settings.wab_token,
            GRAPH_URL: GRAPH_URL,
            API_URL: API_URL
          });
          twClient.sendMessage(phone_number_id, whatsappJsonMessage).then((response) => {
            winston.verbose(
              "(wab) Message sent to WhatsApp! " +
              response.status +
              " " +
              response.statusText
            );
            i += 1;
            if (i < commands.length) {
              execute(commands[i]);
            } else {
              winston.debug("(wab) End of commands");
              return res.sendStatus(200);
            }
          }).catch((err) => {
            winston.error("(wab) send message error: ", err.response.data);
            return res.status(500).send({ success: false, error: "Send message error" });
          });
        } else {
          winston.error("(wab) WhatsappJsonMessage is undefined!");
          return res.status(500).send({ success: false, error: "Translation to whatsapp message failed" });
        }
      }

      //wait
      if (command.type === "wait") {
        setTimeout(() => {
          i += 1;
          if (i < commands.length) {
            execute(commands[i]);
          } else {
            winston.debug("(wab) End of commands");
            return res.sendStatus(200);
          }
        }, command.time);
      }
    }
    execute(commands[0]);
  } else if (tiledeskChannelMessage.text || tiledeskChannelMessage.metadata) {
    let whatsappJsonMessage = await tlr.toWhatsapp(
      tiledeskChannelMessage,
      whatsapp_receiver
    );
    winston.verbose("(wab) whatsappJsonMessage", whatsappJsonMessage);

    if (whatsappJsonMessage) {
      const twClient = new TiledeskWhatsapp({
        token: wab_token,
        GRAPH_URL: GRAPH_URL,
        API_URL: API_URL
      });

      twClient.sendMessage(phone_number_id, whatsappJsonMessage).then((response) => {
        winston.verbose(
          "(wab) Message sent to WhatsApp! " +
          response.status +
          " " +
          response.statusText
        );
        return res.sendStatus(200);
      }).catch((err) => {
        //winston.error("(wab) error send message: ", err);
        return res.status(400).send({ success: false, error: "Template not existing" });
      });
    } else {
      winston.error("(wab) Whatsapp Json Message is undefined!");
      return res.status(400).send({ success: false, error: "An error occurred during message translation" });
    }
  } else {
    winston.debug("(wab) no command, no text --> skip");
    return res.status(400).send({ success: false, error: "No command or text specified. Skip message." });
  }
});

// Endpoint for Whatsapp Business connected via OAuth
router.post('/webhook', async (req, res) => {
  const webhookStartedAt = Date.now();

  if (req.body.object !== "whatsapp_business_account") {
    winston.verbose("(wab) Event not from whatsapp");
    return res.status(400).send({ error: "Invalid request" });
  }

  if (!req.body.entry?.[0]?.id) {
    winston.warn("(wab) Invalid entry for body: ", req.body)
    return res.status(400).send({ error: "Invalid request object" })
  }

  const waba_id = req.body.entry[0].id;

  const CONTENT_KEY = "whatsapp-" + waba_id;
  const settings = await db.get(CONTENT_KEY);
  winston.debug("(wab) settings: ", settings);

  if (!settings) {
    winston.warn("(wab) settings not found for waba: " + waba_id);
    winston.warn("(wab) settings not found for request: ", req.body);
    recordWabaOperation(null, waba_id, {
      level: 'warn',
      event: 'webhook.failed',
      status: 'failed',
      messageId: getWebhookMessageId(req.body),
      latencyMs: Date.now() - webhookStartedAt,
      errorCode: 'settings_not_found',
      errorMessage: 'WhatsApp settings not found for WABA'
    });
    return res.sendStatus(200);
  }

  recordWabaOperation(settings, waba_id, {
    event: 'webhook.received',
    status: 'success',
    messageId: getWebhookMessageId(req.body),
    details: { kind: getWebhookKind(req.body), route: 'oauth' }
  });

  const tdClient = new TiledeskClient({
    projectId: settings.project_id,
    token: settings.token,
    APIURL: API_URL,
    APIKEY: "___",
    log: false,
  });

  const wl = new WhatsappLogger({ tdClient: tdClient });
  wl.forwardMessage(req.body);

  // Message incoming
  if (req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {

    let whatsappChannelMessage = req.body.entry[0].changes[0].value.messages[0];
    if (whatsappChannelMessage.type == "system") {
      winston.verbose("(wab) Skip system message");
      return res.sendStatus(200);
    }

    const tlr = new TiledeskWhatsappTranslator();
    const tdChannel = new TiledeskChannel({ settings: settings, API_URL: API_URL });

    // Try on Whatsapp - Initialize conversation with chatbot
    if (whatsappChannelMessage.text && whatsappChannelMessage.text.body.startsWith("#td")) {
      let code = whatsappChannelMessage.text.body.split(" ")[0];
      const bottester = new TiledeskBotTester({
        project_id: settings.project_id,
        redis_client: redis_client,
        db: db,
        tdChannel: tdChannel,
        tlr: tlr,
      });
      bottester.startBotConversation(req.body, code).then((result) => {
        winston.verbose("(wab) test conversation started");
        winston.debug("(wab) startBotConversation result: ", result);
      }).catch((err) => {
        winston.error("(wab) start test onversation error: ", err);
      });
    }
    // Standard message
    else {
      let firstname = req.body.entry[0].changes[0].value.contacts[0].profile.name;
      let message_info = {
        channel: "whatsapp",
        whatsapp: {
          phone_number_id: req.body.entry[0].changes[0].value.metadata.phone_number_id,
          from: req.body.entry[0].changes[0].value.messages[0].from,
          firstname: req.body.entry[0].changes[0].value.contacts[0].profile.name,
          lastname: " ",
          waba_id: waba_id
        },
      };

      let userToken;
      try {
        userToken = await getUserToken(tdChannel, message_info.whatsapp, settings);
        message_info.userToken = userToken;
      } catch (err) {
        winston.error("(wab) get user token error: ", err);
      }

      let tiledeskJsonMessage;

      let metadata_type = ["image", "video", "document", "audio"];
      if (metadata_type.includes(whatsappChannelMessage.type)) {

        const util = new TiledeskWhatsapp({
          token: settings.wab_token,
          GRAPH_URL: GRAPH_URL,
          API_URL: API_URL,
          BASE_FILE_URL: BASE_FILE_URL
        });

        const media = whatsappChannelMessage[whatsappChannelMessage.type];
        const filename = await util.downloadMedia(media.id);

        if (!filename) {
          winston.debug(`(wab) Unable to download media with id ${media.id}. Message not sent.`);
          recordWabaOperation(settings, waba_id, {
            level: 'error',
            event: 'webhook.failed',
            status: 'failed',
            messageId: whatsappChannelMessage.id,
            latencyMs: Date.now() - webhookStartedAt,
            errorCode: 'media_download_failed',
            errorMessage: 'Unable to download media from WhatsApp',
            details: { mediaType: whatsappChannelMessage.type }
          });
          return res.status(500).send({ success: false, error: "unable to download media" });
        }

        const file_path = path.join(__dirname, "tmp", filename);
        // Use userToken if available, otherwise fallback to settings.token
        const media_url = await util.uploadMedia(file_path, settings.project_id, userToken);
        winston.debug(`(wab) media_url: ${media_url}`);

        tiledeskJsonMessage = await tlr.toTiledesk(whatsappChannelMessage, firstname, media_url);
      } else {
        winston.debug("(wab) message type: ", whatsappChannelMessage.type);
        tiledeskJsonMessage = await tlr.toTiledesk(whatsappChannelMessage, firstname);
      }

      if (tiledeskJsonMessage) {
        winston.verbose("(wab) tiledeskJsonMessage: ", tiledeskJsonMessage);

        try {
          const response = await tdChannel.send(tiledeskJsonMessage, message_info, settings.department_id);
          winston.verbose("(wab) Message sent to Tiledesk!");
          winston.debug("(wab) response: ", response);
        } catch (err) {
          winston.error("(wab) send message error: ", err);
          recordWabaOperation(settings, waba_id, {
            level: 'error',
            event: 'webhook.failed',
            status: 'failed',
            messageId: whatsappChannelMessage.id,
            latencyMs: Date.now() - webhookStartedAt,
            error: err
          });
        }
      } else {
        winston.verbose("(wab) tiledeskJsonMessage is undefined");
        recordWabaOperation(settings, waba_id, {
          level: 'warn',
          event: 'webhook.skipped',
          status: 'skipped',
          messageId: whatsappChannelMessage.id,
          latencyMs: Date.now() - webhookStartedAt,
          details: { reason: 'translation_empty', messageType: whatsappChannelMessage.type }
        });
      }
    }
  }


  // Message status update incoming
  if (req.body.entry?.[0]?.changes?.[0]?.value?.statuses?.[0]) {
    let whatsappStatusMessage = req.body.entry[0].changes[0].value.statuses[0];
    winston.verbose("(wab) whatsappStatusMessage: ", whatsappStatusMessage);

    let message_id = whatsappStatusMessage.id;
    let status = whatsappStatusMessage.status;
    let error = null;
    if (whatsappStatusMessage.errors) {
      error = whatsappStatusMessage.errors[0].title;
    }
    winston.verbose("(wab) update status in " + status + " for message_id " + message_id);

    const tdClient = new TiledeskClient({
      projectId: settings.project_id,
      token: settings.token,
      APIURL: API_URL,
      APIKEY: "___",
      log: false,
    });

    const wl = new WhatsappLogger({ tdClient: tdClient });
    wl.updateMessageStatus(message_id, status, error);
  }

  recordWabaOperation(settings, waba_id, {
    event: 'webhook.processed',
    status: 'success',
    messageId: getWebhookMessageId(req.body),
    latencyMs: Date.now() - webhookStartedAt,
    details: { kind: getWebhookKind(req.body), route: 'oauth' }
  });

  res.sendStatus(200);

})

// Endpoint for Whatsapp Business
router.post("/webhook/:project_id", async (req, res) => {
  const webhookStartedAt = Date.now();
  winston.warn('(wab) Legacy webhook route used for project ' + req.params.project_id + '. Migrate to OAuth.');
  // Parse the request body from the POST
  let project_id = req.params.project_id;
  winston.verbose("(wab) Message received from WhatsApp");

  // Check the Incoming webhook message
  // info on WhatsApp text message payload: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples#text-messages
  if (req.body.object) {
    let CONTENT_KEY = "whatsapp-" + project_id;
    let settings = await db.get(CONTENT_KEY);
    winston.debug("(wab) settings: ", settings);

    if (!settings) {
      winston.warn("(wab) settings not found for project_id: " + project_id);
      winston.warn("(wab) settings not found for request: ", req.body);
      recordWabaOperation({ project_id: project_id }, req.body.entry && req.body.entry[0] && req.body.entry[0].id, {
        level: 'warn',
        event: 'webhook.failed',
        status: 'failed',
        messageId: getWebhookMessageId(req.body),
        latencyMs: Date.now() - webhookStartedAt,
        errorCode: 'settings_not_found',
        errorMessage: 'WhatsApp settings not found for project'
      });
      return res.sendStatus(200);
    }

    recordWabaOperation(settings, req.body.entry && req.body.entry[0] && req.body.entry[0].id, {
      event: 'webhook.received',
      status: 'success',
      messageId: getWebhookMessageId(req.body),
      details: { kind: getWebhookKind(req.body), route: 'legacy' }
    });

    const tdClient = new TiledeskClient({
      projectId: project_id,
      token: settings.token,
      APIURL: API_URL,
      APIKEY: "___",
      log: false,
    });

    const wl = new WhatsappLogger({ tdClient: tdClient });
    wl.forwardMessage(req.body);

    if (
      req.body.entry &&
      req.body.entry[0].changes &&
      req.body.entry[0].changes[0] &&
      req.body.entry[0].changes[0].value.messages &&
      req.body.entry[0].changes[0].value.messages[0]
    ) {
      if (req.body.entry[0].changes[0].value.messages[0].type == "system") {
        winston.verbose("(wab) Skip system message");
        return res.sendStatus(200);
      }

      if (req.body.entry[0].id !== settings.business_account_id) {
        winston.verbose("(wab) Skip message with waba that not belong to Tiledesk project id");
        return res.sendStatus(200);
      }


      let whatsappChannelMessage = req.body.entry[0].changes[0].value.messages[0];
      /*
      let CONTENT_KEY = "whatsapp-" + project_id;
      let settings = await db.get(CONTENT_KEY);
      winston.debug("(wab) settings: ", settings);
      */

      if (!settings) {
        winston.verbose("(wab) No settings found. Exit..");
        return res.sendStatus(200);
      }

      const tlr = new TiledeskWhatsappTranslator();
      const tdChannel = new TiledeskChannel({
        settings: settings,
        API_URL: API_URL,
      });

      // Initialize conversation with chatbot
      if (whatsappChannelMessage.text && whatsappChannelMessage.text.body.startsWith("#td")) {
        let code = whatsappChannelMessage.text.body.split(" ")[0];

        const bottester = new TiledeskBotTester({
          project_id: project_id,
          redis_client: redis_client,
          db: db,
          tdChannel: tdChannel,
          tlr: tlr,
        });
        bottester.startBotConversation(req.body, code).then((result) => {
          winston.verbose("(wab) test conversation started");
          winston.debug("(wab) startBotConversation result: ", result);
        }).catch((err) => {
          winston.error("(wab) start test onversation error: ", err);
        });

        // Standard message
      } else {
        const value = req.body?.entry?.[0]?.changes?.[0]?.value;

        let message_info = {
          channel: "whatsapp",
          whatsapp: {
            phone_number_id: value?.metadata?.phone_number_id || null,
            from: value?.messages?.[0]?.from || null,
            firstname: value?.contacts?.[0]?.profile?.name || "Unknown",
            lastname: " ",
            waba_id: req.body.entry?.[0]?.id || null
          },
        };

        let firstname = message_info.whatsapp.firstname;

        let userToken;
        try {
          userToken = await getUserToken(tdChannel, message_info.whatsapp, settings);
          message_info.userToken = userToken;
        } catch (err) {
          winston.error("(wab) get user token error: ", err);
        }

        let tiledeskJsonMessage;

        if (
          whatsappChannelMessage.type == "image" ||
          whatsappChannelMessage.type == "video" ||
          whatsappChannelMessage.type == "document" ||
          whatsappChannelMessage.type == "audio"
        ) {
          let media;
          const util = new TiledeskWhatsapp({
            token: settings.wab_token,
            GRAPH_URL: GRAPH_URL,
            API_URL: API_URL,
            BASE_FILE_URL: BASE_FILE_URL
          });

          if (whatsappChannelMessage.type == "image") {
            media = whatsappChannelMessage.image;
            const filename = await util.downloadMedia(media.id);
            if (!filename) {
              winston.debug("(wab) Unable to download media with id " + media.id + ". Message not sent.");
              recordWabaOperation(settings, message_info.whatsapp.waba_id, {
                level: 'error',
                event: 'webhook.failed',
                status: 'failed',
                messageId: whatsappChannelMessage.id,
                latencyMs: Date.now() - webhookStartedAt,
                errorCode: 'media_download_failed',
                errorMessage: 'Unable to download image from WhatsApp',
                details: { mediaType: whatsappChannelMessage.type }
              });
              return res.status(500).send({ success: false, error: "unable to download media" });
            }

            let file_path = path.join(__dirname, "tmp", filename);
            const image_url = await util.uploadMedia(file_path, settings.project_id, userToken);
            winston.debug("(wab) image_url: " + image_url);

            tiledeskJsonMessage = await tlr.toTiledesk(whatsappChannelMessage, firstname, image_url);
          }

          if (whatsappChannelMessage.type == "video") {
            media = whatsappChannelMessage.video;

            const filename = await util.downloadMedia(media.id);
            if (!filename) {
              winston.debug("(wab) Unable to download media with id " + media.id + ". Message not sent.");
              recordWabaOperation(settings, message_info.whatsapp.waba_id, {
                level: 'error',
                event: 'webhook.failed',
                status: 'failed',
                messageId: whatsappChannelMessage.id,
                latencyMs: Date.now() - webhookStartedAt,
                errorCode: 'media_download_failed',
                errorMessage: 'Unable to download video from WhatsApp',
                details: { mediaType: whatsappChannelMessage.type }
              });
              return res.status(500).send({ success: false, error: "unable to download media" });
            }
            let file_path = path.join(__dirname, "tmp", filename);

            const media_url = await util.uploadMedia(file_path, settings.project_id, userToken);
            winston.debug("(wab) media_url: " + media_url);

            tiledeskJsonMessage = await tlr.toTiledesk(whatsappChannelMessage, firstname, media_url);
          }

          if (whatsappChannelMessage.type == "document") {
            media = whatsappChannelMessage.document;

            const filename = await util.downloadMedia(media.id);
            if (!filename) {
              winston.debug("(wab) Unable to download media with id " + media.id + ". Message not sent.");
              recordWabaOperation(settings, message_info.whatsapp.waba_id, {
                level: 'error',
                event: 'webhook.failed',
                status: 'failed',
                messageId: whatsappChannelMessage.id,
                latencyMs: Date.now() - webhookStartedAt,
                errorCode: 'media_download_failed',
                errorMessage: 'Unable to download document from WhatsApp',
                details: { mediaType: whatsappChannelMessage.type }
              });
              return res.status(500).send({ success: false, error: "unable to download media" });
            }
            let file_path = path.join(__dirname, "tmp", filename);

            const media_url = await util.uploadMedia(file_path, settings.project_id, userToken);
            winston.debug("(wab) media_url: " + media_url);

            tiledeskJsonMessage = await tlr.toTiledesk(whatsappChannelMessage, firstname, media_url);
          }

          if (whatsappChannelMessage.type == "audio") {
            media = whatsappChannelMessage.audio;

            const filename = await util.downloadMedia(media.id);
            if (!filename) {
              winston.debug("(wab) Unable to download media with id " + media.id + ". Message not sent.");
              recordWabaOperation(settings, message_info.whatsapp.waba_id, {
                level: 'error',
                event: 'webhook.failed',
                status: 'failed',
                messageId: whatsappChannelMessage.id,
                latencyMs: Date.now() - webhookStartedAt,
                errorCode: 'media_download_failed',
                errorMessage: 'Unable to download audio from WhatsApp',
                details: { mediaType: whatsappChannelMessage.type }
              });
              return res.status(500).send({ success: false, error: "unable to download media" });
            }
            let file_path = path.join(__dirname, "tmp", filename);

            const media_url = await util.uploadMedia(file_path, settings.project_id, userToken);
            winston.debug("(wab) media_url: " + media_url);

            tiledeskJsonMessage = await tlr.toTiledesk(whatsappChannelMessage, firstname, media_url);
          }
        } else {
          winston.debug("(wab) message type: ", whatsappChannelMessage.type);
          tiledeskJsonMessage = await tlr.toTiledesk(whatsappChannelMessage, firstname);
        }

        if (tiledeskJsonMessage) {
          winston.verbose("(wab) tiledeskJsonMessage: ", tiledeskJsonMessage);
          const response = await tdChannel.send(tiledeskJsonMessage, message_info, settings.department_id);
          winston.verbose("(wab) Message sent to Tiledesk!");
          winston.debug("(wab) response: ", response);
        } else {
          winston.verbose("(wab) tiledeskJsonMessage is undefined");
          recordWabaOperation(settings, message_info.whatsapp.waba_id, {
            level: 'warn',
            event: 'webhook.skipped',
            status: 'skipped',
            messageId: whatsappChannelMessage.id,
            latencyMs: Date.now() - webhookStartedAt,
            details: { reason: 'translation_empty', messageType: whatsappChannelMessage.type }
          });
        }
      }
    }

    if (
      req.body.entry &&
      req.body.entry[0].changes &&
      req.body.entry[0].changes[0] &&
      req.body.entry[0].changes[0].value.statuses &&
      req.body.entry[0].changes[0].value.statuses[0]
    ) {
      let whatsappStatusMessage = req.body.entry[0].changes[0].value.statuses[0];
      winston.verbose("(wab) whatsappStatusMessage: ", whatsappStatusMessage);

      let message_id = whatsappStatusMessage.id;
      let status = whatsappStatusMessage.status;
      let error = null;
      if (whatsappStatusMessage.errors) {
        error = whatsappStatusMessage.errors[0].title;
      }
      winston.verbose("(wab) update status in " + status + " for message_id " + message_id);

      /*
      let CONTENT_KEY = "whatsapp-" + project_id;
      let settings = await db.get(CONTENT_KEY);
      winston.debug("(wab) settings: ", settings);
      */

      const tdClient = new TiledeskClient({
        projectId: project_id,
        token: settings.token,
        APIURL: API_URL,
        APIKEY: "___",
        log: false,
      });

      const wl = new WhatsappLogger({ tdClient: tdClient });
      wl.updateMessageStatus(message_id, status, error);
    }

    recordWabaOperation(settings, req.body.entry && req.body.entry[0] && req.body.entry[0].id, {
      event: 'webhook.processed',
      status: 'success',
      messageId: getWebhookMessageId(req.body),
      latencyMs: Date.now() - webhookStartedAt,
      details: { kind: getWebhookKind(req.body), route: 'legacy' }
    });

    res.sendStatus(200);
  } else {
    // Return a '404 Not Found' if event is not from a WhatsApp API
    winston.verbose("(wab) event not from whatsapp");
    recordWabaOperation({ project_id: project_id }, undefined, {
      level: 'warn',
      event: 'webhook.failed',
      status: 'failed',
      latencyMs: Date.now() - webhookStartedAt,
      errorCode: 'invalid_payload',
      errorMessage: 'Event not from WhatsApp'
    });
    res.sendStatus(404);
  }
});

// Accepts GET requests at the /webhook endpoint. You need this URL to setup webhook initially.
// info on verification request payload: https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests
router.get("/webhook", async (req, res) => {
  /**
   * UPDATE YOUR VERIFY TOKEN
   *This will be the Verify Token value when you set up webhook
   */
  winston.verbose("(wab) Verify the webhook... ");
  winston.debug("(wab) req.query: " + req.query);

  // Parse params from the webhook verification request
  let mode = req.query["hub.mode"];
  let token = req.query["hub.verify_token"];
  let challenge = req.query["hub.challenge"];

  //let CONTENT_KEY = "whatsapp-" + req.params.project_id;

  //let settings = await db.get(CONTENT_KEY);

  // if (!settings || !settings.verify_token) {
  //   winston.error("(wab) No settings found! Unable to verify token.");
  //   res.sendStatus(403);
  // } else {
  //let VERIFY_TOKEN = settings.verify_token;
  let VERIFY_TOKEN = process.env.VERIFY_TOKEN || "tiledesk-verify-token";
  // Check if a token and mode were sent
  if (mode && token) {
    // Check the mode and token sent are correct
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      // Respond with 200 OK and challenge token from the request
      winston.verbose("(wab) Webhook verified");
      res.status(200).send(challenge);
    } else {
      // Responds with '403 Forbidden' if verify tokens do not match
      winston.error("(wab) mode is not 'subscribe' or token do not match");
      res.sendStatus(403);
    }
  } else {
    winston.error("(wab) mode or token undefined");
    res.status(400).send("impossible to verify the webhook: mode or token undefined.");
  }
  //}
});

// Accepts GET requests at the /webhook endpoint. You need this URL to setup webhook initially.
// info on verification request payload: https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests
router.get("/webhook/:project_id", async (req, res) => {
  /**
   * UPDATE YOUR VERIFY TOKEN
   *This will be the Verify Token value when you set up webhook
   */
  winston.verbose("(wab) Verify the webhook... ");
  winston.debug("(wab) req.query: " + req.query);

  let id_project = req.params.project_id;

  // Parse params from the webhook verification request
  let mode = req.query["hub.mode"];
  let token = req.query["hub.verify_token"];
  let challenge = req.query["hub.challenge"];

  let settings = await utils.getSettingsByProjectId(id_project);
  if (!settings) {
    settings = await utils.getSettings(id_project, null);
  }

  let VERIFY_TOKEN = settings.verify_token;

  // Check if a token and mode were sent
  if (mode && token) {
    // Check the mode and token sent are correct
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      // Respond with 200 OK and challenge token from the request
      winston.verbose("(wab) Webhook verified");
      res.status(200).send(challenge);
    } else {
      // Responds with '403 Forbidden' if verify tokens do not match
      winston.error("(wab) mode is not 'subscribe' or token do not match");
      res.sendStatus(403);
    }
  } else {
    winston.error("(wab) mode or token undefined");
    res.status(400).send("impossible to verify the webhook: mode or token undefined.");
  }
  //}
});
// ***************************************
// ******* MESSAGING SECTION - END *******
// ***************************************

// ---------------------------------------

// ***************************************
// ****** TRY ON WA SECTION - START ******
// ***************************************
router.post("/newtest", async (req, res) => {
  winston.verbose("(wab) initializing new test..");

  let project_id = req.body.project_id;
  let bot_id = req.body.bot_id;

  let info = {
    project_id: project_id,
    bot_id: bot_id,
  };

  let short_uid = uuidv4().substring(0, 8);
  let key = "bottest:" + short_uid;

  if (!redis_client) {
    return res.status(500).send({ message: "Test it out on Whatsapp not available. Redis not ready." });
  }

  await redis_client.set(key, JSON.stringify(info), "EX", 604800);
  redis_client.get(key, (err, value) => {
    if (err) {
      winston.error("(wab) redis get err: ", err);
      return res.status(500).send({ success: "false", message: "Testing info could not be saved" });
    } else {
      winston.debug("(wab) new test initialized with id: " + short_uid);
      return res.status(200).send({ short_uid: short_uid });
    }
  });
});
// ***************************************
// ******* TRY ON WA SECTION - END *******
// ***************************************

// ---------------------------------------

// ***************************************
// ******* APP STORE SECTION - END *******
// ***************************************
router.get("/detail", async (req, res) => {
  winston.verbose("(wab) /detail");

  let project_id = req.query.project_id;
  let token = req.query.token;
  let app_id = req.query.app_id;

  const tdChannel = new TiledeskChannel({
    settings: { project_id: project_id, token: token },
    API_URL: API_URL,
  });
  let isAvailable = await tdChannel.getProjectDetail();
  winston.debug("(wab) app is available: ", isAvailable);
  if (!project_id || !token || !app_id) {
    return res.status(500).send("<p>Ops! An error occured.</p><p>Missing query params! project_id, token and app_id are required.</p>");
  }

  const appClient = new TiledeskAppsClient({ APPS_API_URL: APPS_API_URL });
  let installation = await appClient.getInstallations(project_id, app_id);

  let installed = false;
  if (installation) {
    installed = true;
  }

  readHTMLFile("/detail.html", (err, html) => {
    var template = handlebars.compile(html);
    var replacements = {
      app_version: pjson.version,
      project_id: project_id,
      token: token,
      app_id: app_id,
      installed: installed,
      isAvailable: isAvailable,
    };
    var html = template(replacements);
    res.send(html);
  });
});

router.post("/install", async (req, res) => {
  winston.verbose("(wab) /install");

  let project_id = req.body.project_id;
  let app_id = req.body.app_id;
  let token = req.body.token;

  winston.debug("(wab) Install app " + app_id + " for project id " + project_id);
  let installation_info = {
    project_id: project_id,
    app_id: app_id,
    createdAt: Date.now(),
  };

  const appClient = new TiledeskAppsClient({ APPS_API_URL: APPS_API_URL });
  appClient
    .install(installation_info)
    .then((installation) => {
      winston.debug("(wab) installation response: ", installation);

      res.redirect(
        url.format({
          pathname: BASE_URL + "/detail",
          query: {
            project_id: project_id,
            app_id: app_id,
            token: token,
          },
        })
      );
    })
    .catch((err) => {
      winston.error("(wab) installation error: " + err.data);
      res.send("An error occurred during the installation");
    });
});

router.post("/uninstall", async (req, res) => {
  winston.verbose("(wab) /uninstall");
  let project_id = req.body.project_id;
  let app_id = req.body.app_id;
  let token = req.body.token;

  const appClient = new TiledeskAppsClient({ APPS_API_URL: APPS_API_URL });
  appClient.uninstall(project_id, app_id).then((response) => {
    winston.debug("(wab) uninstallation response: ", response);
    res.redirect(
      url.format({
        pathname: BASE_URL + "/detail",
        query: {
          project_id: project_id,
          app_id: app_id,
          token: token,
        },
      })
    );
  }).catch((err) => {
    winston.error("(wab) uninstallation error: " + err.data);
    res.send("An error occurred during the uninstallation");
  });
});
// ***************************************
// ****** APP STORE SECTION - START ******
// ***************************************

// ---------------------------------------

// ***************************************
// ******* IN DEPRECATION - START ********
// ***************************************
router.get("/templates/detail", async (req, res) => {
  let project_id = req.query.project_id;
  let token = req.query.token;
  let app_id = req.query.app_id;
  let template_id = req.query.id_template;
  winston.debug("(wab) get template_id: " + template_id);

  let CONTENT_KEY = "whatsapp-" + project_id;
  let settings = await db.get(CONTENT_KEY);
  winston.debug("(wab) settings: ", settings);

  if (settings) {
    // forse non serve, comunque non si può prendere un singolo template
    /*
    let tm = new TemplateManager({ token: settings.wab_token, business_account_id: settings.business_account_id, GRAPH_URL: GRAPH_URL })
    let templates_info = await tm.getTemplateNamespace();
    let namespace = templates_info.message_template_namespace;
    let template = await tm.getTemplateById(namespace);
    */
   try {
     let tm = new TemplateManager({
       token: settings.wab_token,
       business_account_id: settings.business_account_id,
       GRAPH_URL: GRAPH_URL,
     });
     let templates = await tm.getTemplates();
     let template = JSON.parse(JSON.stringify(templates.data.find((t) => t.id === template_id)));
     let template_name = template.name;
 
     let template_copy = {
       name: template.name,
       components: template.components,
       language: template.language,
       status: template.status,
       id: template.id,
       category: template.category,
     };
 
     readHTMLFile("/template_detail.html", (err, html) => {
       var template = handlebars.compile(html);
       var replacements = {
         app_version: pjson.version,
         project_id: project_id,
         token: token,
         app_id: app_id,
         name: template_name,
         template: template_copy,
       };
       var html = template(replacements);
       res.send(html);
     });
   } catch (err) {
    winston.error("(wab) Error geting templates: ", err);
    return res.status(500).send({ success: false, error: err?.response?.data || "General error" });
   }
  } else {
    return res.send("whatsapp not installed on this project");
  }
});

router.get("/direct/tiledesk", async (req, res) => {
  winston.verbose("(wab) /direct/tiledesk");

  let project_id = req.query.project_id;
  let whatsapp_receiver = req.query.whatsapp_receiver;
  let phone_number_id = req.query.phone_number_id;

  let direct_phone_number_id = req.query.phone_number_id;
  let settings;
  if (direct_phone_number_id) {
    settings = await utils.getSettingsByPhoneNumberId(direct_phone_number_id);
  }
  if (!settings) {
    settings = await db.get("whatsapp-" + project_id);
  }

  let tiledeskChannelMessage = {
    text: "Sample text",
    attributes: {
      attachment: {
        type: "wa_template",
        template: {
          language: "en_US",
          name: "hello_world",
        }
      }
    }
  };
  const tlr = new TiledeskWhatsappTranslator();
  const twClient = new TiledeskWhatsapp({
    token: settings.wab_token,
    GRAPH_URL: GRAPH_URL,
    API_URL: API_URL
  });

  let whatsappJsonMessage = await tlr.toWhatsapp(
    tiledeskChannelMessage,
    whatsapp_receiver
  );
  winston.verbose("(wab) whatsappJsonMessage", whatsappJsonMessage);

  twClient.sendMessage(phone_number_id, whatsappJsonMessage).then((response) => {
    winston.verbose(
      "(wab) Message sent to WhatsApp! " +
      response.status +
      " " +
      response.statusText
    );
  }).catch((err) => {
    //winston.error("(wab) error send message: ", err);
    return res.status(400).send({ success: false, error: err });
  });

  res.status(200).send("Message sent");
});

// Can be deleted?
router.post("/tiledesk/broadcast", async (req, res) => {
  winston.verbose("(wab) Message received from Tiledesk (Broadcast)");

  let tiledeskChannelMessage = req.body.payload;
  winston.verbose("(wab) tiledeskChannelMessage: ", tiledeskChannelMessage);
  let project_id = req.body.payload.id_project;

  let broadcast_phone_number_id = req.body.phone_number_id;
  let settings;
  if (broadcast_phone_number_id) {
    settings = await utils.getSettingsByPhoneNumberId(broadcast_phone_number_id);
  }
  if (!settings) {
    settings = await db.get("whatsapp-" + project_id);
  }

  if (!settings) {
    return res.status(400).send({ success: false, error: "WhatsApp is not installed for the project_id: " + project_id });
  }

  if (!settings.business_account_id) {
    return res.status(400).send({ success: false, error: "Missing parameter 'WhatsApp Business Account ID'. Please update your app." });
  }

  let receiver_list = req.body.receiver_list;
  let phone_number_id = req.body.phone_number_id;

  let tm = new TemplateManager({
    token: settings.wab_token,
    business_account_id: settings.business_account_id,
    GRAPH_URL: GRAPH_URL,
  });
  const tlr = new TiledeskWhatsappTranslator();
  const twClient = new TiledeskWhatsapp({
    token: settings.wab_token,
    GRAPH_URL: GRAPH_URL,
    API_URL: API_URL
  });

  let response = await tm.getTemplates();
  let templates = response.data;

  let selected_template = templates.find(
    (t) => t.name === tiledeskChannelMessage.attributes.attachment.template.name
  );

  let params_object = await tm.generateParamsObject(selected_template);

  tiledeskChannelMessage.attributes.attachment.template.params = params_object;
  winston.verbose("(wab) --> tiledeskChannelMessage: ", tiledeskChannelMessage);

  let messages_sent = 0;
  let errors = [];
  let error_count = 0;

  if (receiver_list) {
    let i = 0;
    async function execute(whatsapp_receiver) {
      let customTiledeskJsonMessage = await tlr.sanitizeTiledeskMessage(tiledeskChannelMessage, whatsapp_receiver);
      winston.verbose("(wab) customTiledeskJsonMessage: ", customTiledeskJsonMessage);

      let whatsappJsonMessage = await tlr.toWhatsapp(customTiledeskJsonMessage, whatsapp_receiver.phone_number);
      winston.verbose("(wab) message created for receiver: " + whatsapp_receiver.phone_number);
      winston.verbose("(wab) whatsappJsonMessage", whatsappJsonMessage);

      await twClient.sendMessage(phone_number_id, whatsappJsonMessage).then((response) => {
        winston.verbose("(wab) Message sent to WhatsApp! " + response.status + " " + response.statusText);
        messages_sent += 1;
        i += 1;
        if (i < receiver_list.length) {
          execute(receiver_list[i]);
        } else {
          winston.debug("(wab) End of list");
          return res.status(200).send({ success: true, message: "Broadcast terminated", messages_sent: messages_sent, errors: errors });
        }
      }).catch((err) => {
        winston.error("(wab) error send message: " + err.response.data.error.message);
        errors.push({ receiver: whatsapp_receiver.phone_number, error: err.response.data.error.message });
        i += 1;
        if (i < receiver_list.length) {
          execute(receiver_list[i]);
        } else {
          winston.debug("(wab) End of list");
          return res.status(200).send({ success: true, message: "Broadcast terminated", messages_sent: messages_sent, errors: errors });
        }
      });
    }
    execute(receiver_list[0]);
  }
});
// ***************************************
// ******** IN DEPRECATION - END *********
// ***************************************

// ---------------------------------------

// *****************************
// ********* FUNCTIONS *********
// *****************************

async function startApp(settings, callback) {
  winston.info("(wab) Starting Whatsapp App");

  if (!settings.MONGODB_URL) {
    winston.error("(wab) MONGODB_URL is mandatory. Exit...");
    return callback("Missing parameter: MONGODB_URL");
  }

  if (!settings.API_URL) {
    winston.error("(wab) API_URL is mandatory. Exit...");
    return callback("Missing parameter: API_URL");
  } else {
    API_URL = settings.API_URL;
    winston.info("(wab) API_URL: " + API_URL);
  }

  BASE_FILE_URL = settings.BASE_FILE_URL || API_URL;
  winston.info("(wab) BASE_FILE_URL: " + BASE_FILE_URL);

  if (!settings.BASE_URL) {
    winston.error("(wab) BASE_URL is mandatory. Exit...");
    return callback("Missing parameter: BASE_URL");
  } else {
    BASE_URL = settings.BASE_URL;
    winston.info("(wab) BASE_URL: " + BASE_URL);
  }

  if (!settings.GRAPH_URL) {
    winston.error("(wab) GRAPH_URL is mandatory. Exit...");
    return callback("Missing parameter: GRAPH_URL");
  } else {
    GRAPH_URL = settings.GRAPH_URL;
    winston.info("(wab) GRAPH_URL: " + GRAPH_URL);
  }

  if (!settings.APPS_API_URL) {
    winston.error("(wab) APPS_API_URL is mandatory. Exit...");
    return callback("Missing parameter: APPS_API_URL");
  } else {
    APPS_API_URL = settings.APPS_API_URL;
    winston.info("(wab) APPS_API_URL: " + APPS_API_URL);
  }

  if (settings.REDIS_HOST && settings.REDIS_PORT) {
    REDIS_HOST = settings.REDIS_HOST;
    REDIS_PORT = settings.REDIS_PORT;
    REDIS_PASSWORD = REDACTED_SECRET;
    connectRedis();
  } else {
    winston.info("(wab) Missing redis parameters --> Test it out on WhatsApp disabled");
  }

  if (!settings.AMQP_MANAGER_URL) {
    winston.error("(wab) AMQP_MANAGER_URL is mandatory (?). Exit...");
  } else {
    AMQP_MANAGER_URL = settings.AMQP_MANAGER_URL;
    winston.info("(wab) AMQP_MANAGER_URL is present");
  }

  if (!settings.JOB_TOPIC_EXCHANGE) {
    winston.info("(wab) JOB_TOPIC_EXCHANGE should be present. Using default value");
    JOB_TOPIC_EXCHANGE = "tiledesk-whatsapp";
  } else {
    JOB_TOPIC_EXCHANGE = settings.JOB_TOPIC_EXCHANGE;
    winston.info("(wab) JOB_TOPIC_EXCHANGE is present");
  }

  if (settings.BRAND_NAME) {
    BRAND_NAME = settings.BRAND_NAME;
  }

  if (!settings.FB_APP_ID) {
    winston.info("(wab) Missing FB_APP_ID parameter");
  } else {
    FB_APP_ID = process.env.FB_APP_ID;
    winston.info("(wab) FB_APP_ID is present");
  }

  if (!settings.CONFIGURATION_ID) {
    winston.info("(wab) Missing CONFIGURATION_ID parameter");
  } else {
    CONFIGURATION_ID = process.env.CONFIGURATION_ID;
    winston.info("(wab) CONFIGURATION_ID is present");
  }

  // // For test only
  // if (settings.LOG_MONGODB_URL) {
  //   /**
  //    * Connect with a different Database
  //    */
  //   mongoose
  //    .connect(settings.LOG_MONGODB_URL)
  //    .then(() => {
  //      winston.info("Mongoose DB Connected");
  //    })
  //    .catch((err) => {
  //      winston.error("(Mongoose) Unable to connect with MongoDB ", err);
  //    });
  // }

  let LOG_MONGODB_URL;
  if (!settings.LOG_MONGODB_URL) {
    LOG_MONGODB_URL = settings.MONGODB_URL;
  } else {
    LOG_MONGODB_URL = settings.LOG_MONGODB_URL;
  }

  mongoose.connect(LOG_MONGODB_URL).then(() => {
    winston.info("(wab) Mongoose DB Connected");
  }).catch((err) => {
    winston.error("(wab) (Mongoose) Unable to connect with MongoDB ", err);
  });

  if (settings.dbconnection) {
    db.reuseConnection(settings.dbconnection, () => {
      winston.info("(wab) KVBaseMongo reused exsisting db connection");
      if (callback) {
        callback(null);
      }
    });
  } else {
    db.connect(settings.MONGODB_URL, () => {
      winston.info("(wab) KVBaseMongo successfully connected.");

      if (callback) {
        callback(null);
      }
    });
  }

  api.startRoute(
    {
      DB: db,
      API_URL: API_URL,
      GRAPH_URL: GRAPH_URL,
      AMQP_MANAGER_URL: AMQP_MANAGER_URL,
      JOB_TOPIC_EXCHANGE: JOB_TOPIC_EXCHANGE,
    },
    (err) => {
      if (!err) {
        winston.info("(wab) API route successfully started.");
      } else {
        winston.info("(wab) Unable to start API route.");
      }
    }
  );
}

function connectRedis() {
  redis_client = redis.createClient({
    host: REDIS_HOST,
    port: REDIS_PORT,
    password: REDIS_PASSWORD,
  });

  redis_client.on("error", (err) => {
    winston.info("(wab) Connect Redis Error " + err);
  });
  /*
  redis_client.on('connect', () => {
    winston.info('Redis Connected!'); // Connected!
  });
  */
  redis_client.on("ready", () => {
    winston.info("(wab) Redis ready!");
  });
  //await redis_client.connect(); // only for v4
}

function readHTMLFile(templateName, callback) {
  fs.readFile(
    __dirname + "/template" + templateName,
    { encoding: "utf-8" },
    function (err, html) {
      if (err) {
        throw err;
        //callback(err);
      } else {
        callback(null, html);
      }
    }
  );
}

async function getDepartments(project_id, token) {
  try {
    const tdChannel = new TiledeskChannel({
      settings: { project_id, token },
      API_URL,
    });

    const departments = await tdChannel.getDepartments();
    return departments;
  } catch (err) {
    winston.error("(wab) Error getting departments:", err?.response?.data || err.message || err);
    return [];
  }
}

/**
 * Helper function to get or create user token with Redis caching
 * @param {Object} tdChannel - TiledeskChannel instance
 * @param {Object} whatsappChannel - WhatsApp channel info (phone_number_id, from, firstname, lastname)
 * @param {Object} settings - Settings object with project_id
 * @returns {Promise<string>} - The user token
 */
async function getUserToken(tdChannel, whatsappChannel, settings) {
  if (!redis_client) {
    winston.debug("(wab) Redis not available, will sign in without caching");
    // Fallback: create token without caching
    const payload = tdChannel.createUserSignInPayload(whatsappChannel);
    const signInResponse = await tdChannel.signInWithCustomToken(payload);
    let token = signInResponse.data.token;
    return tdChannel.fixToken(token);
  }

  const redisKey = `whatsapp:user_token:${settings.project_id}:${whatsappChannel.phone_number_id}:${whatsappChannel.from}`;
  
  return new Promise((resolve, reject) => {
    redis_client.get(redisKey, async (err, cachedToken) => {
      if (err) {
        winston.error("(wab) Redis get error: ", err);
        // Fallback: create token without caching
        try {
          const payload = tdChannel.createUserSignInPayload(whatsappChannel);
          const signInResponse = await tdChannel.signInWithCustomToken(payload);
          let token = signInResponse.data.token;
          return resolve(tdChannel.fixToken(token));
        } catch (signInErr) {
          return reject(signInErr);
        }
      }

      if (cachedToken) {
        winston.debug("(wab) Token found in Redis cache");
        try {
          const tokenData = JSON.parse(cachedToken);
          return resolve(tokenData.token);
        } catch (parseErr) {
          winston.error("(wab) Error parsing cached token: ", parseErr);
          // Fallback: create new token
          try {
            const payload = tdChannel.createUserSignInPayload(whatsappChannel);
            const signInResponse = await tdChannel.signInWithCustomToken(payload);
            let token = signInResponse.data.token;
            return resolve(tdChannel.fixToken(token));
          } catch (signInErr) {
            return reject(signInErr);
          }
        }
      }

      // Token not in cache, create it
      winston.debug("(wab) Token not in cache, creating new token");
      try {
        const payload = tdChannel.createUserSignInPayload(whatsappChannel);
        const signInResponse = await tdChannel.signInWithCustomToken(payload);
        let token = signInResponse.data.token;
        token = tdChannel.fixToken(token);

        // Save to Redis with 2 days retention (172800 seconds)
        const tokenData = { token: token };
        redis_client.set(redisKey, JSON.stringify(tokenData), "EX", 172800, (setErr) => {
          if (setErr) {
            winston.error("(wab) Redis set error: ", setErr);
          } else {
            winston.debug("(wab) Token saved to Redis cache");
          }
        });

        return resolve(token);
      } catch (signInErr) {
        winston.error("(wab) Error signing in with custom token: ", signInErr);
        return reject(signInErr);
      }
    });
  });
}

module.exports = { router: router, startApp: startApp };
