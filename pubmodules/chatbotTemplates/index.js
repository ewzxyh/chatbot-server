const listener = require("./listener");
const express = require("express");

const templates = require("@tiledesk/tiledesk-chatbot-templates");
const Faq_kb = require("../../models/faq_kb");
const chatcaseTemplates = require("./chatcaseTemplates");

const templatesRoute = express.Router();

templatesRoute.get('/public/templates/windows/:botid', (req, res, next) => {
  const template = chatcaseTemplates.getTemplateById(req.params.botid);

  if (!template) {
    return next();
  }

  return res.send(template);
});

templatesRoute.get('/public/templates/:botid', (req, res, next) => {
  const template = chatcaseTemplates.getTemplatePayloadById(req.params.botid);

  if (!template) {
    return next();
  }

  return res.send(template);
});

templatesRoute.get('/public/templates', async (req, res) => {
  const query = { public: true, certified: true, trashed: { $in: [null, false] } };

  try {
    const bots = await Faq_kb.find(query).lean().exec();
    const localTemplates = chatcaseTemplates.listMetadata();
    const botIds = new Set(bots.map((bot) => String(bot._id)));
    const mergedTemplates = bots.concat(localTemplates.filter((template) => !botIds.has(String(template._id))));

    return res.send(mergedTemplates);
  } catch (err) {
    console.error('GET FAQ-KBs ERROR ', err);
    return res.status(500).send({ success: false, msg: 'Error getting bots.' });
  }
});

templatesRoute.use(templates.router);

module.exports = { listener: listener, templatesRoute: templatesRoute }
