var express = require('express');
var router = express.Router({mergeParams: true});
var Department = require("../models/department");
var Integration = require("../models/integrations");
var departmentService = require("../services/departmentService");

var passport = require('passport');
require('../middleware/passport')(passport);
var validtoken = require('../middleware/valid-token')
var roleChecker = require('../middleware/has-role');

var winston = require('../config/winston');
var cacheUtil = require('../utils/cacheUtil');

var departmentEvent = require("../event/departmentEvent");

var CHANNEL_BINDING_PROVIDERS = ['casezap', 'whatsapp', 'waba'];

function normalizeText(value) {
  if (value === undefined || value === null) {
    return '';
  }

  return String(value).trim();
}

function normalizeChannelBindingProvider(provider) {
  var normalizedProvider = normalizeText(provider).toLowerCase();

  if (normalizedProvider === 'waba') {
    return 'whatsapp';
  }

  if (CHANNEL_BINDING_PROVIDERS.indexOf(normalizedProvider) === -1) {
    return null;
  }

  return normalizedProvider;
}

function addCandidate(candidates, value) {
  var candidate = normalizeText(value);
  if (candidate && candidates.indexOf(candidate) === -1) {
    candidates.push(candidate);
  }
}

function sanitizePublicDepartment(department) {
  if (!department) {
    return department;
  }

  var plainDepartment = typeof department.toObject === 'function' ? department.toObject() : Object.assign({}, department);
  delete plainDepartment.channel_bindings;
  return plainDepartment;
}

function sanitizePublicDepartments(departments) {
  return departments.map(function (department) {
    return sanitizePublicDepartment(department);
  });
}

function normalizeChannelBindings(channelBindings) {
  if (!channelBindings || !channelBindings.provider || !Array.isArray(channelBindings.instances)) {
    return null;
  }

  var provider = normalizeChannelBindingProvider(channelBindings.provider);
  if (!provider) {
    var providerError = new Error('Invalid channel binding provider.');
    providerError.statusCode = 400;
    throw providerError;
  }

  var seen = [];
  var instances = channelBindings.instances.reduce(function (normalizedInstances, instance) {
    if (!instance) {
      return normalizedInstances;
    }

    var id = normalizeText(instance.id);
    var number = normalizeText(instance.number);
    var label = normalizeText(instance.label);

    if (!id && !number) {
      return normalizedInstances;
    }

    var candidates = [];
    addCandidate(candidates, id);
    addCandidate(candidates, number);

    var alreadySeen = candidates.some(function (candidate) {
      return seen.indexOf(candidate) > -1;
    });

    if (alreadySeen) {
      return normalizedInstances;
    }

    candidates.forEach(function (candidate) {
      addCandidate(seen, candidate);
    });

    normalizedInstances.push({
      id: id,
      label: label,
      number: number
    });

    return normalizedInstances;
  }, []);

  if (!instances.length) {
    return null;
  }

  return {
    provider: provider,
    instances: instances
  };
}

function getIntegrationCandidateValues(integration) {
  var candidates = [];
  var value = integration.value || {};

  addCandidate(candidates, integration._id);
  addCandidate(candidates, value.number);
  addCandidate(candidates, value.phone);
  addCandidate(candidates, value.phone_number);
  addCandidate(candidates, value.display_phone_number);
  addCandidate(candidates, value.phone_number_id);
  addCandidate(candidates, value.waba_id);
  addCandidate(candidates, value.business_account_id);
  addCandidate(candidates, value.instanceName);

  return candidates;
}

async function getProjectChannelCandidates(projectid, provider) {
  var integrationName = provider === 'waba' ? 'whatsapp' : provider;
  var integrations = await Integration.find({
    id_project: projectid,
    name: integrationName
  }).select('_id value').lean().exec();
  var candidates = [];

  integrations.forEach(function (integration) {
    getIntegrationCandidateValues(integration).forEach(function (candidate) {
      addCandidate(candidates, candidate);
    });
  });

  return candidates;
}

function ensureBindingsBelongToProject(projectCandidates, channelBindings) {
  channelBindings.instances.forEach(function (instance) {
    var idMatches = instance.id && projectCandidates.indexOf(instance.id) > -1;
    var numberMatches = instance.number && projectCandidates.indexOf(instance.number) > -1;

    if (!idMatches && !numberMatches) {
      var instanceError = new Error('Channel binding instance does not belong to this project.');
      instanceError.statusCode = 400;
      throw instanceError;
    }
  });
}

async function ensureBindingsAreUnique(projectid, channelBindings, currentDepartmentId) {
  var candidates = [];

  channelBindings.instances.forEach(function (instance) {
    addCandidate(candidates, instance.id);
    addCandidate(candidates, instance.number);
  });

  if (!candidates.length) {
    return;
  }

  var query = {
    id_project: projectid,
    status: 1,
    'channel_bindings.provider': channelBindings.provider,
    $or: [
      { 'channel_bindings.instances.id': { $in: candidates } },
      { 'channel_bindings.instances.number': { $in: candidates } }
    ]
  };

  if (currentDepartmentId) {
    query._id = { $ne: currentDepartmentId };
  }

  var existingDepartment = await Department.findOne(query).select('_id name').lean().exec();
  if (existingDepartment) {
    var duplicateError = new Error('Channel binding instance already belongs to another department.');
    duplicateError.statusCode = 409;
    throw duplicateError;
  }
}

async function validateChannelBindings(projectid, channelBindings, currentDepartmentId) {
  var normalizedBindings = normalizeChannelBindings(channelBindings);

  if (!normalizedBindings) {
    return null;
  }

  var projectCandidates = await getProjectChannelCandidates(projectid, normalizedBindings.provider);
  ensureBindingsBelongToProject(projectCandidates, normalizedBindings);
  await ensureBindingsAreUnique(projectid, normalizedBindings, currentDepartmentId);

  return normalizedBindings;
}

function sendChannelBindingError(res, err) {
  var statusCode = err.statusCode || 500;
  var message = statusCode === 500 ? 'Error validating channel bindings.' : err.message;

  if (statusCode === 500) {
    winston.error('Error validating department channel bindings ', err);
  }

  return res.status(statusCode).send({ success: false, msg: message });
}

router.post('/', [passport.authenticate(['basic', 'jwt'], { session: false }), validtoken, roleChecker.hasRole('admin')], async function (req, res) {

  winston.debug("DEPT REQ BODY ", req.body);
  var channelBindings;
  try {
    channelBindings = await validateChannelBindings(req.projectid, req.body.channel_bindings);
  } catch (err) {
    return sendChannelBindingError(res, err);
  }

  var newDepartment = new Department({
      routing: req.body.routing,
      name: req.body.name,
      description: req.body.description,
      default: req.body.default,
      status: req.body.status,
      id_group: req.body.id_group,
      groups: req.body.groups,
      channel_bindings: channelBindings,
      id_project: req.projectid,
      createdBy: req.user.id,
      updatedBy: req.user.id
  });

  if (req.body.id_bot) {
      newDepartment.id_bot = req.body.id_bot;
      newDepartment.bot_only = req.body.bot_only;
  }


  newDepartment.save(function (err, savedDepartment) {
      if (err) {
      winston.error('Error creating the department ', err);
      return res.status(500).send({ success: false, msg: 'Error saving object.' });
      }
      winston.debug('NEW DEPT SAVED ', savedDepartment);
      departmentEvent.emit('department.create', savedDepartment);
      res.json(savedDepartment);
  });
});



router.put('/:departmentid', [passport.authenticate(['basic', 'jwt'], { session: false }), validtoken, roleChecker.hasRole('admin')], async function (req, res) {

  winston.debug(req.body);

  var update = {};

  // qui errore su visibile invisible
  // if (req.body.id_bot!=undefined) {
      update.id_bot = req.body.id_bot;
  // }
  if (req.body.bot_only!=undefined) {
      update.bot_only = req.body.bot_only;
  }
  if (req.body.routing!=undefined) {
      update.routing = req.body.routing;
  }
  if (req.body.name!=undefined) {
      update.name = req.body.name;
  }
  if (req.body.description!=undefined) {
      update.description = req.body.description;
  }  
  // if (req.body.id_group!=undefined) {
      update.id_group = req.body.id_group;
  // }
  if (req.body.online_msg!=undefined) {
      update.online_msg = req.body.online_msg;
  }
  if (req.body.status!=undefined) {
      update.status = req.body.status;
  }
  if (req.body.groups!=undefined) {
    update.groups = req.body.groups;
  }      
  if (req.body.channel_bindings !== undefined) {
    try {
      update.channel_bindings = await validateChannelBindings(req.projectid, req.body.channel_bindings, req.params.departmentid);
    } catch (err) {
      return sendChannelBindingError(res, err);
    }
  }


  Department.findOneAndUpdate({ _id: req.params.departmentid, id_project: req.projectid }, update, { new: true }, function (err, updatedDepartment) {
      if (err) {
      winston.error('Error putting the department ', err);
      return res.status(500).send({ success: false, msg: 'Error updating object.' });
      }
      if (!updatedDepartment) {
        return res.status(404).send({ success: false, msg: 'Object not found.' });
      }
      departmentEvent.emit('department.update', updatedDepartment);
      res.json(updatedDepartment);
  });
  });


  router.patch('/:departmentid', [passport.authenticate(['basic', 'jwt'], { session: false }), validtoken, roleChecker.hasRole('admin')], async function (req, res) {

    winston.debug(req.body);
  
    var update = {};
  
   
    if (req.body.status!=undefined) {
        update.status = req.body.status;
    }
    if (req.body.id_bot!=undefined) {
      update.id_bot = req.body.id_bot;
    }
    if (req.body.bot_only!=undefined) {
      update.bot_only = req.body.bot_only;
    }
    if (req.body.routing!=undefined) {
        update.routing = req.body.routing;
    }
    if (req.body.name!=undefined) {
        update.name = req.body.name;
    }
    if (req.body.description!=undefined) {
        update.description = req.body.description;
    }  
    if (req.body.id_group!=undefined) {
        update.id_group = req.body.id_group;
    }    
    if (req.body.groups!=undefined) {
      update.groups = req.body.groups;
    }      
    if (req.body.channel_bindings !== undefined) {
      try {
        update.channel_bindings = await validateChannelBindings(req.projectid, req.body.channel_bindings, req.params.departmentid);
      } catch (err) {
        return sendChannelBindingError(res, err);
      }
    }
  
  
    Department.findOneAndUpdate({ _id: req.params.departmentid, id_project: req.projectid }, update, { new: true }, function (err, updatedDepartment) {
        if (err) {
        winston.error('Error patching the department ', err);
        return res.status(500).send({ success: false, msg: 'Error patching object.' });
        }
        if (!updatedDepartment) {
          return res.status(404).send({ success: false, msg: 'Object not found.' });
        }
        departmentEvent.emit('department.update', updatedDepartment);
        res.json(updatedDepartment);
    });
    });


  // TODO aggiungere altro endpoint qui che calcola busy status come calculate di tiledesk-queue


router.get('/:departmentid/operators', [passport.authenticate(['basic', 'jwt'], { session: false }), validtoken, roleChecker.hasRoleOrTypes('agent', ['bot','subscription'])], async (req, res) => {
  winston.debug("Getting department operators req.projectid: "+req.projectid);
  
  var disableWebHookCall = undefined;
  if (req.query.disableWebHookCall) {
    disableWebHookCall = (req.query.disableWebHookCall == 'true') ;
  }

  winston.debug("disableWebHookCall: "+ disableWebHookCall);

  // getOperators(departmentid, projectid, nobot) {


    var context = {req:req};
    var operatorsResult = await departmentService.getOperators(req.params.departmentid, req.projectid, req.query.nobot, disableWebHookCall, context);
    winston.debug("Getting department operators operatorsResult", operatorsResult);

    delete operatorsResult.context;
    return res.status(200).send(operatorsResult);

});


// ======================== ./END - GET MY DEPTS ========================

// GET ALL DEPTS (i.e. NOT FILTERED FOR STATUS and WITH AUTHENTICATION (USED BY THE DASHBOARD)
router.get('/allstatus', [passport.authenticate(['basic', 'jwt'], { session: false }), validtoken, roleChecker.hasRoleOrTypes('agent', ['bot','subscription'])], function (req, res) {

  // winston.debug("## GET ALL DEPTS req.project.isActiveSubscription ", req.project.isActiveSubscription)
  // winston.debug("## GET ALL DEPTS req.project.trialExpired ", req.project.trialExpired)

  // if (req.project.profile) {
  //   winston.debug("## GET ALL DEPTS eq.project.profile.type ", req.project.profile.type);
  // }

  winston.debug("## GET ALL DEPTS req.project ", req.project)

  var query = { "id_project": req.projectid, status: { $gte:  0 } }; // nascondi quelli con status = hidden (-1) for dashboard
                                            //secondo me qui manca un parentesi tonda per gli or
  if (req.project && req.project.profile && (req.project.profile.type === 'free' && req.project.trialExpired === true) || (req.project.profile.type === 'payment' && req.project.isActiveSubscription === false)) {

    query.default = true;
  }


  if (req.query.sort) {
    // return Department.find({ "id_project": req.projectid }).sort({ updatedAt: 'desc' }).exec(function (err, departments) {
    // QUESTO LO COMMENTO 11.09.19 return Department.find({ "id_project": req.projectid }).sort({ name: 'asc' }).exec(function (err, departments) { 
      winston.debug("## GET ALL DEPTS QUERY (1)", query)
    return Department.find(query).sort({ name: 'asc' }).exec(function (err, departments) {

      if (err) {
        winston.error('Error getting the departments.', err);
        winston.debug('Error getting the departments.', err);
        return res.status(500).send({ success: false, msg: 'Error getting the departments.', err: err });
      }

      return res.json(departments);
    });
  } else {
    winston.debug("## GET ALL DEPTS QUERY (1)", query)
    // return Department.find({ "id_project": req.projectid }, function (err, departments) {
    return Department.find(query)
    //@DISABLED_CACHE .cache(cacheUtil.defaultTTL, req.projectid+":departments:query:allstatus")
    .exec(function (err, departments) {
      if (err) {
        winston.error('Error getting the departments.', err);
        return res.status(500).send({ success: false, msg: 'Error getting the departments.', err: err });
      }

      return res.json(departments);
    });
  }
});


router.get('/:departmentid', function (req, res) {
  winston.debug(req.body);

  let departmentid = req.params.departmentid;


  if (departmentid == "default") {
    winston.debug("departmentid", departmentid);

    var query = {};
    // winston.debug("req.query", req.query);

    // if (req.appid) {
    query.id_project = req.projectid;
    query.default = true;
    // }

    winston.debug("query", query);

    Department.findOne(query, function (err, department) {
      if (err) return (err);

      return res.json(sanitizePublicDepartment(department));
    });

  } else {
    Department.findById(departmentid, function (err, department) {
      if (err) {
        return res.status(500).send({ success: false, msg: 'Error getting object.' });
      }
      if (!department) {
        return res.status(404).send({ success: false, msg: 'Object not found.' });
      }
      res.json(sanitizePublicDepartment(department));
    });
  }

});

// router.get('/', passport.authenticate(['anonymous'], { session: false }), function (req, res) {

// GET DEPTS FILTERED FOR STATUS === 1 and WITHOUT AUTHENTICATION (USED BY THE WIDGET)
// note:THE STATUS EQUAL TO 1 CORRESPONDS TO THE DEPARTMENTS VISIBLE THE STATUS EQUAL TO 0 CORRESPONDS TO THE HIDDEN DEPARTMENTS
router.get('/', function (req, res) {

  winston.debug("req projectid", req.projectid);
  winston.debug("req.query.sort", req.query.sort);


  var query = { "id_project": req.projectid, "status": 1 };
  winston.debug('GET DEPTS FILTERED FOR STATUS === 1 req.projectid ', req.projectid);
  if (req.project && req.project.profile) {
    winston.debug('GET DEPTS FILTERED FOR STATUS === 1 req.project.profile.type ', req.project.profile.type);
  }
  winston.debug('GET DEPTS FILTERED FOR STATUS === 1 req.project.profile.type ',  req.project.trialExpired);
  winston.debug('GET DEPTS FILTERED FOR STATUS === 1 req.project.isActiveSubscription ',  req.project.isActiveSubscription);
  
                                            //secondo me qui manca un parentesi tonda per gli or
  if (req.project && req.project.profile && (req.project.profile.type === 'free' && req.project.trialExpired === true) || (req.project.profile.type === 'payment' && req.project.isActiveSubscription === false)) {

    query.default = true;
  }

  if (req.query.sort) {
    // COMMENTO QUESTO 11.09.19 return Department.find({ "id_project": req.projectid, "status": 1 }).sort({ name: 'asc' }).exec(function (err, departments) {
    return Department.find(query).sort({ name: 'asc' }).exec(function (err, departments) {

      if (err) {
        winston.error('Error getting the departments.', err);
        return res.status(500).send({ success: false, msg: 'Error getting the departments.', err: err });
      }

      return res.json(sanitizePublicDepartments(departments));
    });
  } else {
    return Department.find(query, function (err, departments) {
      if (err) {
        winston.error('Error getting the departments.', err);
        return res.status(500).send({ success: false, msg: 'Error getting the departments.', err: err });
      }

      return res.json(sanitizePublicDepartments(departments));
    });
  }
});

router.delete('/:departmentid', [passport.authenticate(['basic', 'jwt'], { session: false }), validtoken, roleChecker.hasRole('admin')], function (req, res) {

  winston.debug(req.body);
  winston.debug("req.params.departmentid: "+req.params.departmentid);

  Department.findOneAndRemove({_id: req.params.departmentid}, function (err, department) {
  // Department.remove({ _id: req.params.departmentid }, function (err, department) {
      
      if (err) {
      winston.error('Error deleting the department ', err);
      return res.status(500).send({ success: false, msg: 'Error deleting object.' });
      }
      // nn funziuona perchje nn c'è id_project
      departmentEvent.emit('department.delete', department);
      res.json(department);
  });
});

if (process.env.NODE_ENV === 'test') {
  router._private = {
    normalizeChannelBindings: normalizeChannelBindings,
    ensureBindingsAreUnique: ensureBindingsAreUnique,
    sanitizePublicDepartment: sanitizePublicDepartment,
    sanitizePublicDepartments: sanitizePublicDepartments
  };
}

module.exports = router;
