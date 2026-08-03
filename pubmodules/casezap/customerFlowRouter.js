'use strict';

var CUSTOMER_TYPE = {
  CUSTOMER: 'customer',
  NEW: 'new'
};

function resolveCustomerFlow(attributes, isSavedContact) {
  var current = attributes || {};
  var currentType = current.casezapCustomerType;
  var currentSource = current.casezapCustomerTypeSource;

  // A persisted customer classification is sticky even if the contact is later removed.
  if (currentType === CUSTOMER_TYPE.CUSTOMER) {
    return {
      customerType: CUSTOMER_TYPE.CUSTOMER,
      source: currentSource || 'persisted'
    };
  }

  if (isSavedContact) {
    return {
      customerType: CUSTOMER_TYPE.CUSTOMER,
      source: 'saved_contact'
    };
  }

  return {
    customerType: CUSTOMER_TYPE.NEW,
    source: currentSource || 'unsaved_contact'
  };
}

function getStartCommand(customerType) {
  return customerType === CUSTOMER_TYPE.CUSTOMER ? '2' : '1';
}

function buildAttributeUpdate(attributes, isSavedContact) {
  var current = attributes || {};
  var classification = resolveCustomerFlow(current, isSavedContact);
  var update = {};
  var savedContact = Boolean(isSavedContact);

  if (current.casezapSavedContact !== savedContact) {
    update['attributes.casezapSavedContact'] = savedContact;
  }
  if (current.casezapCustomerType !== classification.customerType) {
    update['attributes.casezapCustomerType'] = classification.customerType;
  }
  if (current.casezapCustomerTypeSource !== classification.source) {
    update['attributes.casezapCustomerTypeSource'] = classification.source;
  }

  return {
    classification: classification,
    update: update
  };
}

module.exports = {
  CUSTOMER_TYPE: CUSTOMER_TYPE,
  resolveCustomerFlow: resolveCustomerFlow,
  getStartCommand: getStartCommand,
  buildAttributeUpdate: buildAttributeUpdate
};
