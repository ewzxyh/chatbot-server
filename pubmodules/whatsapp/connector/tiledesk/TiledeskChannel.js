const axios = require("axios").default;
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const winston = require('../winston')
const utils = require('../utils/utils');

class TiledeskChannel {

  /**
    * Constructor for TiledeskChannel
    *
    * @example
    * const { TiledeskChannel } = require('tiledesk-channel');
    * const tdChannel = new TiledeskChannel({tiledeskJsonMessage: replyFromWhatsapp, settings: appSettings, whatsappJsonMessage: originalWhatsappMessage, API_URL: tiledeskApiUrl });
    * 
    * @param {Object} config JSON configuration.
    * @param {string} config.tiledeskJsonMessage Mandatory. Message translated from Whatsapp to Tiledesk
    * @param {string} config.whatsappJsonMessage Mandatory. Original whatsapp message.
    * @param {string} config.settings Mandatory. Installation settings.
    * @param {string} config.API_URL Mandatory. Tiledesk api url.
    * @param {boolean} options.log Optional. If true HTTP requests are logged.
    */
  
  constructor(config) {
    if (!config) {
      throw new Error('config is mandatory');
    }

    if (!config.settings) {
      throw new Error('config.settings is mandatory');
    }

    if (!config.API_URL) {
      throw new Error('config.API_URL is mandatory');
    }

    this.log = false;
    if (config.log) {
      this.log = config.log;
    }

    this.settings = config.settings;
    this.API_URL = config.API_URL;

  }

  /**
   * Send a message to Tiledesk
   * @param {Object} tiledeskMessage - The message to send
   * @param {Object} messageInfo - The message info
   * @param {string} department_id - The department ID
   * @returns {Promise<Object>} - The response from the Tiledesk API
   */
  async send(tiledeskMessage, messageInfo, department_id) {

    let channel;
    let request_id;
    let new_request_id;

    if (department_id) {
      tiledeskMessage.departmentid = department_id;
    }

    if (messageInfo.channel == "whatsapp") {
      channel = messageInfo.whatsapp;
      new_request_id = "support-group-" + this.settings.project_id + "-" + uuidv4().substring(0, 8) + "-wab-" + channel.phone_number_id + "-" + channel.from;

    } else if (messageInfo.channel == "telegram") {
      channel = messageInfo.telegram;
      // Check it
      //new_request_id = "support-group-" + projectId + "-" + uuidv4() + "-telegram-" + from;

    } else if (messageInfo.channel == "messenger") {
      channel = messageInfo.messenger;
      // Check it
      //new_request_id = hased_request_id = "support-group-" + projectId + "-" + uuidv4() + "-" + sender_id + "-" + webhook_event.recipient.id;

    } else {
      winston.verbose("(wab) [TiledeskChannel] Channel not supported")
      return null;
    }

    // Assume userToken is always provided
    const token = messageInfo.userToken;

    try {
      const requestsResponse = await this.getRequests(messageInfo.channel, token);
      winston.debug("(wab) [TiledeskChannel] get request response: ", requestsResponse.data);

      if (requestsResponse.data.requests[0]) {
        request_id = requestsResponse.data.requests[0].request_id;
        winston.debug("(wab) [TiledeskChannel] Old request_id: " + request_id);
      } else {
        request_id = new_request_id;
        winston.debug("(wab) [TiledeskChannel] New request_id: " + request_id);
      }

    } catch (err) {
      const errorMessage = utils._extractErrorMessage(err);
      winston.error("(wab) [TiledeskChannel] get requests error: " + errorMessage);
      throw new Error(errorMessage);
    }

    if (messageInfo.channel === "whatsapp" && messageInfo.whatsapp) {
      if (!tiledeskMessage.attributes) tiledeskMessage.attributes = {};
      tiledeskMessage.attributes.waba_id = messageInfo.whatsapp.waba_id || null;
      tiledeskMessage.attributes.whatsapp_phone_number_id = messageInfo.whatsapp.phone_number_id || null;
    }

    winston.debug("(wab) [TiledeskChannel] tiledeskMessage:", tiledeskMessage);

    try {
      const sendResponse = await this.sendMessage(request_id, tiledeskMessage, token);
      winston.debug("(wab) [TiledeskChannel] send message response: ", sendResponse.data);
      return sendResponse.data;
    } catch (err) {
      const errorMessage = utils._extractErrorMessage(err);
      winston.error("(wab) [TiledeskChannel] send message error: " + errorMessage);
      throw new Error(errorMessage);
    }
        
  }

  /**
   * Get requests for the current user
   * @param {string} channel - The channel name
   * @param {string} token - The user token
   * @returns {Promise<Object>} - The response from the Tiledesk API
   */
  async getRequests(channel, token) {
    return axios({
      url: this.API_URL + `/${this.settings.project_id}/requests/me?channel=${channel}`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token
      },
      method: 'GET'
    });
  }

  /**
   * Send a message to a request
   * @param {string} request_id - The request ID
   * @param {Object} tiledeskMessage - The message to send
   * @param {string} token - The user token
   * @returns {Promise<Object>} - The response from the Tiledesk API
   */
  async sendMessage(request_id, tiledeskMessage, token) {
    return axios({
      url: this.API_URL + `/${this.settings.project_id}/requests/${request_id}/messages`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token
      },
      data: tiledeskMessage,
      method: 'POST'
    });
  }


  /**
   * Get the departments from Tiledesk
   * @returns {Promise<Object>} - The response from the Tiledesk API
   */
  async getDepartments() {

    return await axios({
      url: this.API_URL + "/" + this.settings.project_id + "/departments/allstatus",
      headers: {
        'Content-Type': 'application/json',
        'Authorization': this.settings.token 
      },
      method: 'GET'
    }).then((response) => {
      winston.debug("(wab) [TiledeskChannel] get departments response.data: ", response.data)
      return response.data;
    }).catch((err) => {
      return err;
      //winston.error("(wab) [TiledeskChannel] get departments error: ", err.response.data);
    })
  }

  /**
   * Send a message to Tiledesk and add a bot
   * @param {Object} tiledeskMessage - The message to send
   * @param {Object} messageInfo - The message info
   * @param {string} bot_id - The bot ID
   * @returns {Promise<Object>} - The response from the Tiledesk API
   */
  async sendAndAddBot(tiledeskMessage, messageInfo, bot_id) {
    
    let channel;
    let new_request_id;
    tiledeskMessage.participants = ["bot_" + bot_id];
    tiledeskMessage.attributes = {
      sourcePage: "whatsapp://&td_draft=true",
      waba_id: messageInfo.whatsapp ? messageInfo.whatsapp.waba_id : null,
      whatsapp_phone_number_id: messageInfo.whatsapp ? messageInfo.whatsapp.phone_number_id : null
    }

    if (messageInfo.channel == "whatsapp") {
      channel = messageInfo.whatsapp;
      new_request_id = "support-group-" + this.settings.project_id + "-" + uuidv4().substring(0, 8) + "-wab-" + channel.phone_number_id + "-" + channel.from;
    } else {
      winston.verbose("(wab) [TiledeskChannel] Channel not supported")
      return null;
    }

    var payload = {
      _id: 'wab-' + channel.from,
      first_name: channel.firstname,
      last_name: channel.lastname,
      sub: 'userexternal',
      aud: 'https://tiledesk.com/subscriptions/' + this.settings.subscriptionId
    }

    var customToken = jwt.sign(payload, this.settings.secret);

    return await axios({
      url: this.API_URL + "/auth/signinWithCustomToken",
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'JWT ' + customToken
      },
      data: {},
      method: 'POST'
    }).then((response) => {
      
      let token = response.data.token;
      token = this.fixToken(token);

      return axios({
        url: this.API_URL + `/${this.settings.project_id}/requests/${new_request_id}/messages`,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token
        },
        data: tiledeskMessage,
        method: 'POST'
      }).then((response) => {
        return response.data
      }).catch((err) => {
        const errorMessage = utils._extractErrorMessage(err);
        winston.error("(wab) [TiledeskChannel] send message (open conversation) error: " + errorMessage);
      })
    }).catch((err) => {
      const errorMessage = utils._extractErrorMessage(err);
      winston.error("(wab) [TiledeskChannel] sign in error: " + errorMessage);
    })
  }

  /**
   * Get the project detail from Tiledesk
   * @returns {Promise<Object>} - The response from the Tiledesk API
   */
  async getProjectDetail() {

    return await axios({
      url: this.API_URL + '/projects/' + this.settings.project_id,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': this.settings.token
      },
      method: 'GET'
    }).then((response) => {
      return this.checkPlan(response.data);
    }).catch((err) => {
      const errorMessage = utils._extractErrorMessage(err);
      winston.error("(wab) [TiledeskChannel] get project detail error: " + errorMessage);
      return null;
    })
  }

  /**
   * Sign in with custom token
   * @param {Object} payload - The payload to sign in with
   * @returns {Promise<Object>} - The response from the Tiledesk API
   */
  signInWithCustomToken(payload) {
    var customToken = jwt.sign(payload, this.settings.secret);
    
    return axios({
      url: this.API_URL + "/auth/signinWithCustomToken",
      headers: {
        'Content-Type': 'application/json',
        'Authorization': "JWT " + customToken
      },
      data: {},
      method: 'POST'
    });
  }



  /**
   * Check the plan of the project
   * @param {Object} project - The project
   * @returns {Promise<boolean>} - True if the plan is available, false otherwise
   */
  checkPlan(project) {
    let profile_name = project.profile.name;
    let profile_type = project.profile.type;
    let isActiveSubscription = project.isActiveSubscription;
    let trialExpired = project.trialExpired;

    winston.debug("profile_name: " + profile_name)
    winston.debug("profile_type: " + profile_type)
    winston.debug("isActiveSubscription: " + isActiveSubscription)
    
    return new Promise((resolve, reject) => {
      if (
        ((profile_name === 'Growth' || profile_name === 'Basic')) ||
        ((profile_name === 'Scale' || profile_name === 'Premium') && isActiveSubscription === false) ||
        ((profile_name === 'Plus' || profile_name === 'Custom') && isActiveSubscription === false) ||
        (profile_type === 'free' && trialExpired === true) 
      ) {
        winston.verbose('Feature not available')
        resolve(false);

      } else if (
        ((profile_name === 'Scale' || profile_name === 'Premium') && isActiveSubscription === true) ||
        ((profile_name === 'Plus' || profile_name === 'Custom') && isActiveSubscription === true) ||
        (profile_type === 'free' && trialExpired === false)
      ) {
        winston.verbose('Feature available')
        resolve(true);
        
      } else {
        winston.verbose('Other case: feature not available');
        resolve(false);
      }
    })
  }

  createUserSignInPayload(channel) {
    return {
      _id: 'wab-' + channel.from,
      first_name: channel.firstname,
      last_name: channel.lastname,
      phone: channel.from,
      sub: 'userexternal',
      aud: 'https://tiledesk.com/subscriptions/' + this.settings.subscriptionId
    }
  }

  
  fixToken(token) {
    
    let index = token.lastIndexOf("JWT ");
    if (index != -1) {
      let new_token = token.substring(index + 4);
      return 'JWT ' + new_token;
    } else {
      return 'JWT ' + token;
    }
    
  }

}

module.exports = { TiledeskChannel }

