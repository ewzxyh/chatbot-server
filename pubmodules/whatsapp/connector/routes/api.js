const express = require('express');
var winston = require('../winston');
const router = express.Router({ mergeParams: true });
var parsecsv = require("fast-csv");
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const fs = require('fs');

const { TemplateManager } = require('../tiledesk/TemplateManager');
const { TiledeskWhatsappTranslator } = require('../tiledesk/TiledeskWhatsappTranslator');
const { TiledeskWhatsapp } = require('../tiledesk/TiledeskWhatsapp');
const { Scheduler } = require('../tiledesk/Scheduler');
const Utils = require('../tiledesk/Utils');

let db = null;
let API_URL = null;
let GRAPH_URL = null;
let AMQP_MANAGER_URL = null;
let JOB_TOPIC_EXCHANGE = null;
let utils = null;

router.get('/', async (req, res) => {
  res.status(200).send({ message: "API route works"})
})

router.get('/disconnect/:project_id', async (req, res) => {

  let project_id = req.params.project_id;

  let settings = await utils.getSettingsByProjectId(project_id);
  if (!settings) {
    settings = await utils.getSettings(project_id, null);
  }
  
  if (!settings) {
    return res.status(200).send({ success: false, message: "Unable to find content for the projectId " + project_id })
  }

  if (req.query.ghost && req.query.ghost === 'true') {
    settings.trashed = true;
    await db.set(CONTENT_KEY, settings);
    winston.verbose("(wab) Content deleted.");
    res.status(200).send({ success: true, message: "Disconnected" });
    
  } else {
    await db.remove(CONTENT_KEY);
    winston.verbose("(wab) Content deleted.");
    res.status(200).send({ success: true, message: "Disconnected" });
  }

})

router.post('/customer/io', async (req, res) => {
  winston.verbose("Event received from customer.io");
  winston.debug("Body (customer.io): ", req.body);

  let tiledeskChannelMessage = req.body;

  let project_id = req.body.id_project;

  let settings = await utils.getSettingsByProjectId(project_id);
  if (!settings) {
    settings = await utils.getSettings(project_id, null);
  }

  if (!settings) {
    return res.status(500).send({ success: false, message: "WhatsApp not installed for the projectId: " + project_id });
  }

  const tlr = new TiledeskWhatsappTranslator();

  let receiver = tiledeskChannelMessage.receiver_phone_number;
  let phone_number_id = tiledeskChannelMessage.phone_number_id;

  let whatsappJsonMessage = await tlr.toWhatsapp(tiledeskChannelMessage, receiver);
  winston.debug("[ CUSTOMER.IO ] whatsappJsonMessage: ", JSON.stringify(whatsappJsonMessage, null, 2));

  if (whatsappJsonMessage) {
    const twClient = new TiledeskWhatsapp({ 
      token: settings.wab_token, 
      GRAPH_URL: GRAPH_URL, 
      API_URL: API_URL
    });

    twClient.sendMessage(phone_number_id, whatsappJsonMessage).then((response) => {
        winston.verbose("(wab) Message sent to WhatsApp! " + response.status + " " + response.statusText);
      res.status(200).send({ success: true, message: "Message sent!"});
    }).catch((err) => {
      res.status(400).send({ success: false, error: err });
      winston.error("(wab) error send message: ", err.data);
    })

  } else {
      winston.error("(wab) whatsappJsonMessage is undefined");
      res.status(400).send({ success: false, error: "whatsappJsonMessage is undefined" });
      
  }
})

router.get("/:project_id", async (req, res) => {
  winston.verbose("(wab) /api/project_id");

  let project_id = req.params.project_id;
  let settings = await utils.getSettingsByProjectId(project_id);
  if (!settings) {
    settings = await utils.getSettings(project_id, null);
  }

  if (!settings) {
    return res.status(200).send({ success: false, message: "WhatsApp not installed for the project_id " + project_id })
  }
  return res.status(200).send({ success: true, settings: settings })
})

router.get("/templates/:project_id", async (req, res) => {
  winston.verbose("(wab) /api/templates");

  let project_id = req.params.project_id;

  let settings = await utils.getSettingsByProjectId(project_id);
  if (!settings) {
    settings = await utils.getSettings(project_id, null);
  }

  if (settings) {

    if (settings.business_account_id) {

      let waba_id = settings.waba_id || settings.business_account_id;
      let tm = new TemplateManager({ token: settings.wab_token, waba_id: waba_id, GRAPH_URL: GRAPH_URL })
      let templates = await tm.getTemplates();
      if (templates) {
        res.status(200).send(templates.data);
      } else {
        res.status(500).send({ success: false, code: '02', message: "A problem occurred while getting templates from WhatsApp" })
      }

    } else {
      res.status(500).send({ success: false, code: '03', message: "Missing parameter 'WhatsApp Business Account ID'. Please update your app." })
    }

  } else {
    res.status(400).send({ success: false, code: '01', message: "WhatsApp not installed for the project_id " + project_id })
  }
})

router.post('/tiledesk/broadcast', async (req, res) => {
  winston.verbose("(wab) Action received from Tiledesk (Broadcast)");
  winston.debug("Body (broadcast): ", JSON.stringify(req.body, null, 2));

  const { id_project, template, receiver_list, phone_number_id, transaction_id, broadcast = true } = req.body;

  const requiredFields = ['id_project', 'template', 'phone_number_id'];
  const missingFields = requiredFields.filter(field => !req.body[field]);

  if (missingFields.length > 0) {
    return res.status(400).send({ success: false, error: `Missing parameters: ${missingFields.join(', ')}` });
  }

  if (!transaction_id) {
    transaction_id = "tiledesk-broadcast-" + Date.now();
  }

  let settings = await utils.getSettingsByProjectId(id_project);
  if (!settings) {
    settings = await utils.getSettings(id_project, null);
  }

  if (!settings) {
    return res.status(400).send({ success: false, error: "WhatsApp is not installed for the project_id: " + id_project });
  }

  if (!settings.business_account_id) {
    return res.status(400).send({ success: false, error: "Missing parameter 'WhatsApp Business Account ID'. Please update your app."})
  }

  let scheduler = new Scheduler({ AMQP_MANAGER_URL: AMQP_MANAGER_URL, JOB_TOPIC_EXCHANGE: JOB_TOPIC_EXCHANGE });
  let data_To_scheduler = { 
    project_id: id_project, 
    receiver_list: receiver_list, 
    phone_number_id: phone_number_id, 
    transaction_id: transaction_id,
    template: template, 
    settings: settings,
    broadcast: broadcast
  };

  winston.debug('(wab) data_To_scheduler: ', data_To_scheduler);

  let schedulerResult = await scheduler.goSchedule(data_To_scheduler);
  winston.verbose('(wab) schedulerResult: ', schedulerResult);

  res.status(200).send({ success: true, message: "Job started. Send messages in queue." })
  
})

router.post('/tiledesk/broadcast/csv', upload.single('uploadFile'), async (req, res) => {
  const { id_project, template_name, template_language, transaction_id, broadcast = true } = req.body;

  const requiredFields = ['id_project', 'template_name', 'template_language'];
  const missingFields = requiredFields.filter(field => !req.body[field]);

  if (missingFields.length > 0) {
    return res.status(400).send({ success: false, error: `Missing parameters: ${missingFields.join(', ')}` });
  }

  if (!req.file) {
    return res.status(400).send({ success: false, error: 'CSV file is missing.' });
  }

  const records = [];

  var csv = req.file.buffer.toString('utf8');
  const parser = parsecsv.parseString(csv, { headers: true, delimiter: ';'});

  parser.on("error", (err) => {
    winston.error("(wab) Error parsing csv ", err);
    return res.status(500).send({ success: false, error: "Error parsing csv" })
  })

  parser.on("data", (data) => {
    records.push(data);
  })

  parser.on("end", async () => {
    
    const tlr = new TiledeskWhatsappTranslator();
    const receiver_list = await tlr.createReceiversList(records);
    
    winston.debug("(wab) broadcast from csv receiver_list: ", receiver_list);

    const final_transaction_id = transaction_id || `automation-request-${id_project}-${Date.now()}`;

    let settings = await utils.getSettingsByProjectId(id_project);
    if (!settings) {
      settings = await utils.getSettings(id_project, null);
    }

    if (!settings || !settings.business_account_id) {
      return res.status(400).json({ success: false, error: "WhatsApp not configured or missing business_account_id." });
    }

    const template = {
      name: template_name,
      language: template_language
    }

    const scheduler = new Scheduler({ AMQP_MANAGER_URL, JOB_TOPIC_EXCHANGE });
    const data = {
      project_id: id_project,
      receiver_list,
      phone_number_id: settings.phone_number_id,
      transaction_id: final_transaction_id,
      template,
      settings,
      broadcast
    };

    const schedulerResult = await scheduler.goSchedule(data);
    winston.verbose("(wab) scheduler result: ", schedulerResult);

    res.status(200).send({ success: true, message: "Job started. Send messages in queue.", automation_id: final_transaction_id })
  })
  
});



// start api route from whatsappRoute
async function startRoute(settings, callback) {
  //winston.info("(wab api) Starting api route", settings);
  winston.info("(wab api) Starting api route");

  if (!settings.DB) {
    winston.error("(wab api) db id mandatory. Exit...");
    return callback('Missing parameter: db');
  } else {
    db = settings.DB;

    utils = new Utils({ db: db });
    //winston.info("(wab) db " + db);
  }

  if (!settings.GRAPH_URL) {
    winston.error("(wab api) GRAPH_URL is mandatory. Exit...");
    return callback('Missing parameter: GRAPH_URL');
  } else {
    GRAPH_URL = settings.GRAPH_URL;
    winston.info("(wab api) GRAPH_URL: " + GRAPH_URL);
  }

  if (!settings.API_URL) {
    winston.error("(wab api) API_URL is mandatory. Exit...");
    return callback('Missing parameter: API_URL');
  } else {
    API_URL = settings.API_URL;
    winston.info("(wab api) API_URL: " + API_URL);
  }


  if (!settings.AMQP_MANAGER_URL) {
    winston.error("(wab api) AMQP_MANAGER_URL is mandatory (?). Exit...");
  } else {
    AMQP_MANAGER_URL = settings.AMQP_MANAGER_URL;
    winston.info("(wab api) AMQP_MANAGER_URL is present");
  }

  if (!settings.JOB_TOPIC_EXCHANGE) {
    winston.error("(wab api) JOB_TOPIC_EXCHANGE is mandatory (?). Exit...");
  } else {
    JOB_TOPIC_EXCHANGE = settings.JOB_TOPIC_EXCHANGE;
    winston.info("(wab api) JOB_TOPIC_EXCHANGE is present");
  }
  
}

module.exports = { router: router, startRoute: startRoute };