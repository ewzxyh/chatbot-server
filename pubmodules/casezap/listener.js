var winston = require('../../config/winston');
var configGlobal = require('../../config/global');
var connector = require('./connector');

var apiUrl = process.env.API_URL || configGlobal.apiUrl;
var casezapEnabled = process.env.CASEZAP_ENABLED !== 'false';

class Listener {

  listen(config) {
    if (!casezapEnabled) {
      winston.info('CaseZap module disabled via CASEZAP_ENABLED=false');
      return;
    }

    winston.info('CaseZap Listener initializing');

    var baseUrl = apiUrl;

    connector.setupOutboundListener();
    connector.setupIntegrationListener(baseUrl);

    winston.info('CaseZap Listener initialized. Base URL: ' + baseUrl);
  }
}

var listener = new Listener();

module.exports = listener;
