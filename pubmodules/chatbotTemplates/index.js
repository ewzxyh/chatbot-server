const listener = require("./listener");
const express = require("express");

const templates = require("@tiledesk/tiledesk-chatbot-templates");
const Faq_kb = require("../../models/faq_kb");
const chatcaseTemplates = require("./chatcaseTemplates");

const templatesRoute = express.Router();

templatesRoute.get('/public/templates/windows/:botid', (req, res, next) => {
  const template = chatcaseTemplates.getTemplateById(req.params.botid);
  const channel = chatcaseTemplates.normalizeChannel(req.query.channel);

  if (!template) {
    return next();
  }

  if (channel && channel !== 'all' && !chatcaseTemplates.templateSupportsChannel(template, channel)) {
    return next();
  }

  return res.send(chatcaseTemplates.prepareTemplateForChannel(template, channel));
});

templatesRoute.get('/public/templates/:botid/export', (req, res, next) => {
  const template = chatcaseTemplates.getTemplateExportById(req.params.botid, { channel: req.query.channel });

  if (!template) {
    return next();
  }

  const safeFilename = String(req.params.botid || 'chatcase-template').replace(/[^a-z0-9._-]/gi, '-');
  res.set('Content-Disposition', `attachment; filename="${safeFilename}.json"`);
  return res.type('json').send(template);
});

templatesRoute.get('/public/templates/:botid', (req, res, next) => {
  const template = chatcaseTemplates.getTemplatePayloadById(req.params.botid, { channel: req.query.channel });

  if (!template) {
    return next();
  }

  return res.send(template);
});

templatesRoute.get('/public/templates', async (req, res) => {
  const query = { public: true, certified: true, trashed: { $in: [null, false] } };
  const channel = chatcaseTemplates.normalizeChannel(req.query.channel);

  try {
    const bots = await Faq_kb.find(query).lean().exec();
    const localTemplates = chatcaseTemplates.listMetadata({ channel });
    const botIds = new Set(bots.map((bot) => String(bot._id)));
    const mergedTemplates = bots
      .concat(localTemplates.filter((template) => !botIds.has(String(template._id))))
      .filter((template) => chatcaseTemplates.templateSupportsChannel(template, channel))
      .map((template) => chatcaseTemplates.prepareTemplateForChannel(template, channel));

    return res.send(mergedTemplates);
  } catch (err) {
    console.error('GET FAQ-KBs ERROR ', err);
    return res.status(500).send({ success: false, msg: 'Error getting bots.' });
  }
});

templatesRoute.use(templates.router);

module.exports = { listener: listener, templatesRoute: templatesRoute }
