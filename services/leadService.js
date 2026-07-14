'use strict';

var Lead = require("../models/lead");
const uuidv4 = require('uuid/v4');
const leadEvent = require('../event/leadEvent');
var winston = require('../config/winston');
var cacheUtil = require('../utils/cacheUtil');
var cacheEnabler = require("../services/cacheEnabler");
var phoneUtil = require('../utils/phoneUtil');
var Project = require("../models/project");
var LeadConstants = require("../models/leadConstants");
var { getPlan } = require('../pubmodules/billing/plans');


class LeadService {


  findByEmail(email, id_project) {
    var that = this;
    return new Promise(function (resolve, reject) {
      return Lead.findOne({email: email, id_project: id_project})
      //@DISABLED_CACHE .cache(cacheUtil.defaultTTL, id_project+":leads:email:"+email)  //lead_cache
      .exec(function(err, lead)  {
          if (err) {
            return reject(err);
          }
          if (!lead) {
            return resolve(null);
          }
          return resolve(lead);
      
      });
    });
  }

 


  createIfNotExists(fullname, email, id_project, createdBy, attributes, status) {
    var that = this;
    return new Promise(function (resolve, reject) {
      that.findByEmail(email, id_project).then(function(lead) {
      // return Lead.findOne({email: email, id_project: id_project}, function(err, lead)  {         
          if (!lead) {
            return resolve(that.create(fullname, email, id_project, createdBy, attributes, status));
          }
          return resolve(lead);
      
      }).catch(function(err) {
        return resolve(that.create(fullname, email, id_project, createdBy, attributes, status));
      })
    });
  }

  
  create(fullname, email, id_project, createdBy, attributes, status) {
    return this.createWitId(null, fullname, email, id_project, createdBy, attributes, status);
  }



  createIfNotExistsWithLeadId(lead_id, fullname, email, id_project, createdBy, attributes, status, phone) {
    if (!createdBy) {
      createdBy = "system";
    }

    return new Promise(function (resolve, reject) {
      var updateOp = {
          $setOnInsert: {
            lead_id: lead_id,
            id_project: id_project,
            createdBy: createdBy
          },
          $set: {}
        };
        if (fullname) {
          updateOp.$set.fullname = fullname;
        } else if (phone) {
          updateOp.$setOnInsert.fullname = phone;
        }
        if (email) updateOp.$set.email = email;
        if (phone) updateOp.$set.phone = phone;
        if (attributes) updateOp.$set.attributes = attributes;
        if (status) updateOp.$set.status = status;
        if (Object.keys(updateOp.$set).length === 0) delete updateOp.$set;

      Lead.findOneAndUpdate(
        { lead_id: lead_id, id_project: id_project },
        updateOp,
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).exec(function(err, lead) {
        if (err) {
          winston.error("Error createIfNotExistsWithLeadId", err);
          return reject(err);
        }
        if (lead && !lead.createdBy) {
          lead.createdBy = createdBy;
          return lead.save(function(saveErr, savedLead) {
            if (saveErr) {
              winston.error("Error repairing lead createdBy", saveErr);
              return reject(saveErr);
            }
            resolve(savedLead);
          });
        }
        resolve(lead);
      });
    });
  }


  updateStatusWitId(lead_id, id_project, status) {
    winston.debug("lead_id: "+ lead_id);
    winston.debug("id_project: "+ id_project);
    winston.debug("status: "+ status);

    return new Promise(function (resolve, reject) {

    var update = {};

    update.status = status;

    
      Lead.findOneAndUpdate({lead_id:lead_id}, update, { new: true, upsert: true }, function (err, updatedLead) {
        if (err) {
          winston.error('Error updating lead ', err);
          return reject(err);
        }

      
        leadEvent.emit('lead.update', updatedLead);
        return resolve(updatedLead);
      });
    });
  }

  updateWitId(lead_id, fullname, email, id_project, status, phone) {
    var that = this;
    winston.debug("updateWitId lead_id: "+ lead_id);
    winston.debug("fullname: "+ fullname);
    winston.debug("email: "+ email);
    winston.debug("id_project: "+ id_project);
    winston.debug("status: "+ status);

    return new Promise(function (resolve, reject) {

    var update = {};

    update.fullname = fullname;
    update.email = email;
    if (phone !== undefined) {
      update.phone = phoneUtil.normalizePhone(phone);
    }
    if (status) {
      update.status = status;
    }
    

    
      Lead.findOneAndUpdate({lead_id: lead_id, id_project: id_project}, update, { new: true, upsert: true }, function (err, updatedLead) {
        if (err) {
          winston.error('Error updating lead ', err);
          return reject(err);
        }


        leadEvent.emit('lead.update', updatedLead);
        leadEvent.emit('lead.email.update', updatedLead);
        leadEvent.emit('lead.fullname.update', updatedLead);
        leadEvent.emit('lead.fullname.email.update', updatedLead);
        that.checkContactsQuota(id_project).then(function(quota) {
          if (!quota.allowed) {
            leadEvent.emit('lead.quota.exceeded', { projectId: id_project, current: quota.current, limit: quota.limit });
          }
        }).catch(function() {});
        return resolve(updatedLead);
      });
    });
  }

  createWitId(lead_id, fullname, email, id_project, createdBy, attributes, status, phone) {
    var that = this;

    if (!createdBy) {
      createdBy = "system";
    }

    if (!lead_id) {
      lead_id = uuidv4();
    }

    return new Promise(function (resolve, reject) {

            var newLead = new Lead({
              lead_id: lead_id,
              fullname: fullname,
              email: email,
              phone: phoneUtil.normalizePhone(phone),
              attributes: attributes,
              status: status,
              id_project: id_project,
              createdBy: createdBy,
              updatedBy: createdBy
            });
          
            newLead.save(function(err, savedLead) {
              if (err) {
                winston.error('Error saving the lead '+ JSON.stringify(newLead), err)
                return reject(err);
              }            
              winston.verbose('Lead created ', newLead.toJSON());

              leadEvent.emit('lead.create', newLead);
              that.checkContactsQuota(id_project).then(function(quota) {
                if (!quota.allowed) {
                  leadEvent.emit('lead.quota.exceeded', { projectId: id_project, current: quota.current, limit: quota.limit });
                }
              }).catch(function() {});
              return resolve(savedLead);
            });
        });


  }

  async checkContactsQuota(id_project) {
    try {
      var project = await Project.findById(id_project).select('profile').lean();
      if (!project || !project.profile) {
        return { allowed: true, current: 0, limit: 0 };
      }

      var plan = getPlan(project.profile.name || 'free');
      var limit = (project.profile.quotes && project.profile.quotes.contacts) || plan.quotes.contacts || 200;
      var current = await Lead.countDocuments({ id_project: id_project, status: LeadConstants.NORMAL });

      var percent = limit > 0 ? Math.round((current / limit) * 100) : 0;
      var allowed = current < limit;

      var thresholds = [100, 95, 75, 50];
      for (var i = 0; i < thresholds.length; i++) {
        if (percent >= thresholds[i]) {
          if (leadEvent) {
            leadEvent.emit('lead.quota.threshold', { projectId: id_project, percent: percent, threshold: thresholds[i], current: current, limit: limit });
          }
          break;
        }
      }

      return { allowed: allowed, current: current, limit: limit, percent: percent };
    } catch (err) {
      winston.error('checkContactsQuota error', err);
      return { allowed: true, current: 0, limit: 0 };
    }
  }

}
var leadService = new LeadService();


module.exports = leadService;
