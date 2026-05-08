const axios = require("axios").default;
const fs = require('fs');
const FormData = require('form-data');
const path = require('path');
const winston = require('../winston')

class TiledeskWhatsapp {

  /**
   * Constructor for TiledeskWhatsapp
   *
   * @example
   * const { TiledeskWhatsapp } = require('tiledesk-whatsapp');
   * const twclient = new TiledeskWhatsappClient({ token: whatsappBusinessToken });
   * 
   * @param {Object} config JSON configuration.
   * @param {string} config.token Mandatory. Token required for authentication.
   * @param {string} config.GRAPH_URL Mandatory. Url for facebook whatsapp api.
   * @param {boolean} options.log Optional. If true HTTP requests are logged.
   */

  constructor(config) {
    if (!config) {
      throw new Error('config is mandatory');
    }

    if (!config.token) {
      throw new Error('config.token is mandatory');
    }

    if (!config.GRAPH_URL) {
      throw new Error('config.GRAPH_URL is mandatory');
    }
    
    if (!config.API_URL) {
      throw new Error('config.API_URL is mandatory');
    }

    // this.media = config.channelMedia;
    this.token = config.token;
    this.GRAPH_URL = config.GRAPH_URL
    this.api_url = config.API_URL.replace(/\/+$/, '');
    this.base_file_url = (config.BASE_FILE_URL || config.API_URL).replace(/\/+$/, '');


    this.log = false;
    if (config.log) {
      this.log = config.log;
    }
  }

  /**
   * Send a message to a WhatsApp number
   * @param {string} phone_number_id - The WhatsApp number ID
   * @param {Object} message - The message to send
   * @returns {Promise<Object>} - The response from the WhatsApp API
   */
  async sendMessage(phone_number_id, message) {
    
    winston.debug("(wab) [TiledeskWhatsapp] Sending message...");

    return await axios({
      url: this.GRAPH_URL + phone_number_id + "/messages?access_token=" + this.token,
      headers: {
        "Content-Type": "application/json",
      },
      data: message,
      method: "POST"
    }).then((response) => {
      winston.debug("(wab) [TiledeskWhatsapp] Message sent!");
      return response
    }).catch((err) => {
      winston.error("(wab) [TiledeskWhatsapp] Send message error: ", err.response.data);
      throw err;
    })
  }
  
  /**
   * Get the business account info
   * @param {string} business_account_id - The business account ID
   * @returns {Promise<Object>} - The response from the WhatsApp API
   */
  async getBusinessAccountInfo(business_account_id) {
    
    winston.debug("(wab) [TiledeskWhatsapp] Getting business account info...");
    
    return await axios({
      url: this.GRAPH_URL + business_account_id + "/phone_numbers?access_token=" + this.token,
      headers: {
        "Content-Type": "application/json"
      },
      method: "GET"
    }).then((response) => {
      winston.debug("(wab) [TiledeskWhatsapp] Business account info response ", response);
      return response.data;
    }).catch((err) => {
      winston.error("(wab) [TiledeskWhatsapp] Gettings account info error ", err);
      throw err;
    })
  }

  /**
   * Download a media file from WhatsApp
   * @param {string} mediaId - The media ID
   * @returns {Promise<string>} - The path to the downloaded file
   */
  async downloadMedia(mediaId) {
    
    return await axios({
      url: this.GRAPH_URL + mediaId,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': "Bearer " + this.token
      }
    }).then(async (response) => {

      let download_url = response.data.url;
      let mime_type = response.data.mime_type;
      let extension = mime_type.substring(mime_type.lastIndexOf("/") + 1);
      if (extension === 'ogg') {
        extension = 'mp3'
      }
      let tid = this.getId();
      let type = "media-" + tid + "." + extension;

      let example_path = path.join(__dirname, '..', 'tmp', type);
      const writeStream = fs.createWriteStream(example_path);
      winston.debug("(wab) [TiledeskWhatsapp] Downloading file..." + example_path);

      return await axios({
        url: download_url,
        method: 'GET',
        headers: {
          'Authorization': "Bearer " + this.token
        },
        responseType: 'stream'
      }).then((response) => {

        return new Promise((resolve, reject) => {
          response.data.pipe(writeStream);
          let error = null;
          writeStream.on('error', err => {
            error = err;
            writeStream.close();
            winston.debug("(wab) [TiledeskWhatsapp] Download failed")
            reject(err);
          });
          writeStream.on('close', () => {
            if (!error) {
              winston.debug("(wab) [TiledeskWhatsapp] Download completed")
              resolve(type);
            }
          })
        })
      }).catch((err) => {
        winston.error("(wab) [TiledeskWhatsapp] download file error: ", err.data);
      })
    }).catch((err) => {
      winston.error("(wab) [TiledeskWhatsapp] get file error: ", err.data);
    })
  }

  /**
   * Upload a media file on Tiledesk
   * @param {string} path - The path to the media file
   * @param {string} id_project - The project ID
   * @param {string} token - The Tiledesk token
   * @returns {Promise<string>} - The URL of the uploaded file
   */
  async uploadMedia(path, id_project, token) {
    let url = `${this.api_url}/${id_project}/files/chat`;
    winston.debug("(wab) [TiledeskWhatsapp] Uploading file...");

    const form = new FormData();
    form.append('file', fs.createReadStream(path));
    const request_config = {
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      headers: {
        ...form.getHeaders(),
        'Authorization': token
      }
    }

    return await axios.post(url, form, request_config).then((response) => {
        
      winston.debug("(wab) [TiledeskWhatsapp] upload response: ", response.data);
      let file_url = this.base_file_url + "/files/download?path=" + encodeURIComponent(response.data.filename);
      return file_url;

    }).catch((err) => {
      if (err.response?.status === 413) {
        winston.warn("(wab) file size limit exceeded");
      } else {
        winston.warn("(wab) uploadMedia general error: ", err);
      }
      return null;
    })
  }
  

  // HTTP REQUEST
  static async myrequest(options, callback, log) {
    
    return await axios({
      url: options.url,
      method: options.method,
      data: options.json,
      params: options.params,
      headers: options.headers
    }).then((res) => {
      if (res && res.status == 200 && res.data) {
        if (callback) {
          callback(null, res.data);
        }
      }
      else {
        if (callback) {
          callback(TiledeskClient.getErr({ message: "Response status not 200" }, options, res), null, null);
        }
      }
    }).catch((err) => {
      winston.error("(wab) [TiledeskWhatsapp] An error occured: ", err);
      if (callback) {
        callback(err, null, null);
      }
    })
  }


  // FUNCTIONS

  getId() {
    var newTime = Math.floor((new Date()).getTime() / 1000) - 1546300800;//seconds since 01/01/2019
    return newTime.toString(36);
  }

}

module.exports = { TiledeskWhatsapp };
