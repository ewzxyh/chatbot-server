let express = require('express');
let router = express.Router();
var winston = require('../config/winston');
let Integration = require('../models/integrations');
const cacheEnabler = require('../services/cacheEnabler');
var cacheUtil = require('../utils/cacheUtil');
const integrationEvent = require('../event/integrationEvent');

const PLATFORM_CHANNELS = ['whatsapp', 'telegram', 'messenger', 'sms', 'voice', 'voice_twilio', 'casezap'];

function sanitizeIntegration(integration) {
    if (!integration) return integration;
    var obj = integration.toObject ? integration.toObject() : Object.assign({}, integration);
    if (obj.value && obj.value.webhookSecret) {
        delete obj.value.webhookSecret;
    }
    return obj;
}

function sanitizeIntegrations(integrations) {
    if (!Array.isArray(integrations)) return integrations;
    return integrations.map(sanitizeIntegration);
}

// Get all integration for a project id
router.get('/', async (req, res) => {

    let id_project = req.projectid;
    winston.debug("Get all integration for the project " + id_project);

    let i = Integration.find({ id_project: id_project });
    if (cacheEnabler.integrations) {
        // cacheUtil.longTTL is 1 hour (default), evaluate 1 month (2592000 s)
        i.cache(cacheUtil.longTTL, "project:" + id_project + ":integrations");
        winston.debug('integration cache enabled for get all integrations');
    }
    i.exec((err, integrations) => {
        if (err) {
            winston.error("Error getting integrations: ", err);
            return res.status(500).send({ success: false, message: "Error getting integrations "});
        }
        res.status(200).send(sanitizeIntegrations(integrations));
    })
    // without cache
    // Integration.find({ id_project: id_project }, (err, integrations) => {
    //     if (err) {
    //         console.error("Error finding all integrations for the project " + id_project + " - err: " + err);
    //         return res.status(404).send({ success: false, err: err })
    //     }
    //     console.log("Integrations found: ", integrations);
    //     res.status(200).send(integrations);
    // })
})

// Get one integration
router.get('/:integration_id', async (req, res) => {
    
    let integration_id = req.params.integration_id;
    winston.debug("Get integration with id " + integration_id);

    Integration.findById(integration_id, (err, integration) => {
        if (err) {
            winston.error("Error find integration by id: ", err);
            return res.status(404).send({ success: false, err: err });
        }
        res.status(200).send(sanitizeIntegration(integration));
    })

})

router.get('/name/:integration_name', async (req, res) => {

    let id_project = req.projectid;
    winston.debug("Get all integration for the project " + id_project);

    let integration_name = req.params.integration_name;
    winston.debug("Get integration with id " + integration_name);

    Integration.findOne({ id_project: id_project, name: integration_name }, (err, integration) => {
        if (err) {
            winston.error("Error find integration by name: ", err);
            return res.status(404).send({ success: false, err: err });
        }

        if (!integration) {
            winston.debug("Integration not found");
            return res.status(200).send("Integration not found");
        }
        
        res.status(200).send(sanitizeIntegration(integration));
    })
})

router.get('/name/:integration_name/instances', async (req, res) => {

    let id_project = req.projectid;
    let integration_name = req.params.integration_name;

    Integration.find({ id_project: id_project, name: integration_name }, (err, integrations) => {
        if (err) {
            winston.error("Error finding integrations by name: ", err);
            return res.status(500).send({ success: false, err: err });
        }
        res.status(200).send(sanitizeIntegrations(integrations));
    })
})

// Add new integration
router.post('/', async (req, res) => {

    let id_project = req.projectid;
    winston.debug("Add new integration ", req.body);

    var CHANNEL_FLAG_MAP = { 'whatsapp': 'whatsapp', 'telegram': 'telegram', 'messenger': 'messanger', 'casezap': 'casezap' };

    if (PLATFORM_CHANNELS.includes(req.body.name)) {
        var flagName = CHANNEL_FLAG_MAP[req.body.name];
        if (flagName) {
            var customization = req.project && req.project.profile && req.project.profile.customization;
            if (customization && customization[flagName] === false) {
                return res.status(403).json({
                    error: 'channel_not_available',
                    message: 'Channel ' + req.body.name + ' is not available on your plan',
                    channel: req.body.name
                });
            }
        }

        try {
            let platformsCount = await Integration.countDocuments({ id_project: id_project, name: { $in: PLATFORM_CHANNELS } });
            let platformsLimit = (req.project && req.project.profile && req.project.profile.quotes && req.project.profile.quotes.platforms) || 1;
            if (platformsCount >= platformsLimit) {
                return res.status(403).json({
                    error: 'platforms_limit_reached',
                    message: 'Platform limit reached for your plan',
                    limit: platformsLimit,
                    current: platformsCount
                });
            }
        } catch (quotaErr) {
            winston.error("Error checking platforms quota", quotaErr);
            return res.status(500).json({ error: 'Error checking platform quota' });
        }

        if (req.body.name === 'casezap' && req.body.value && req.body.value.domain && req.body.value.token) {
            try {
                let intraDup = await Integration.findOne({
                    id_project: id_project,
                    name: 'casezap',
                    'value.domain': req.body.value.domain,
                    'value.token': req.body.value.token
                });
                if (intraDup) {
                    return res.status(409).json({
                        error: 'casezap_duplicate_instance_same_project',
                        message: 'This UazApi instance is already connected in this project'
                    });
                }

                let crossDup = await Integration.findOne({
                    name: 'casezap',
                    id_project: { $ne: id_project },
                    'value.domain': req.body.value.domain,
                    'value.token': req.body.value.token
                });
                if (crossDup) {
                    return res.status(409).json({
                        error: 'casezap_duplicate_instance',
                        message: 'This UazApi instance is already connected to another project'
                    });
                }
            } catch (dupErr) {
                winston.error('Error checking CaseZap duplicate', dupErr);
            }
        }

        let newIntegration = new Integration({
            id_project: id_project,
            name: req.body.name,
            value: req.body.value || {}
        });

        newIntegration.save(function(err, savedIntegration) {
            if (err) {
                winston.error("Error creating new integration ", err);
                return res.status(500).send({ success: false, err: err });
            }

            Integration.find({ id_project: id_project }, function(err, integrations) {
                if (!err) {
                    integrationEvent.emit('integration.update', integrations, id_project);
                }
            });

            res.status(200).send(sanitizeIntegration(savedIntegration));
        });

    } else {
        let newIntegration = {
            id_project: id_project,
            name: req.body.name
        };
        if (req.body.value) {
            newIntegration.value = req.body.value;
        }

        Integration.findOneAndUpdate({ id_project: id_project, name: req.body.name }, newIntegration, { new: true, upsert: true, setDefaultsOnInsert: false }, function(err, savedIntegration) {
            if (err) {
                winston.error("Error creating new integration ", err);
                return res.status(404).send({ success: false, err: err });
            }

            Integration.find({ id_project: id_project }, function(err, integrations) {
                if (!err) {
                    integrationEvent.emit('integration.update', integrations, id_project);
                }
            });

            res.status(200).send(sanitizeIntegration(savedIntegration));
        });
    }
})

router.put('/:integration_id', async (req, res) => {

    let id_project = req.projectid;
    let integration_id = req.params.integration_id;
    
    let update = {};
    if (req.body.name != undefined) {
        update.name = req.body.name;
    }
    if (req.body.value != undefined) {
        update.value = req.body.value
    }

    Integration.findByIdAndUpdate(integration_id, update, { new: true }, (err, savedIntegration) => {
        if (err) {
            winston.error("Error find by id and update integration: ", err);
            return res.status({ success: false, error: err })
        }

        Integration.find({ id_project: id_project }, (err, integrations) => {
            if (err) {
                winston.error("Error getting all integrations");
            } else {
                integrationEvent.emit('integration.update', integrations, id_project);
            }
        })

        res.status(200).send(sanitizeIntegration(savedIntegration));
    })
})

router.delete('/:integration_id', async (req, res) => {

    let id_project = req.projectid;
    let integration_id = req.params.integration_id;

    Integration.findByIdAndDelete(integration_id, (err, result) => {
        if (err) {
            winston.error("Error find by id and delete integration: ", err);
            return res.status({ success: false, error: err })
        }

        Integration.find({ id_project: id_project }, (err, integrations) => {
            if (err) {
                winston.error("Error getting all integrations");
            } else {
                integrationEvent.emit('integration.update', integrations, id_project);
            }
        })

        res.status(200).send({ success: true, messages: "Integration deleted successfully"});

    })
})


module.exports = router;