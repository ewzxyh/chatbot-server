class Utils {

    constructor(config) {
        if (!config) {
            throw new Error('config is mandatory');
        }

        if (!config.db) {
            throw new Error('config db is mandatory');
        }

        this.db = config.db;
    }

    async getSettings(project_id, waba_id) {
        if (waba_id) {
          let settings = await this.db.get('whatsapp-' + waba_id);
          if (settings) return settings;
        }
        return await this.db.get('whatsapp-' + project_id);
    }
      
    async getSettingsByProjectId(project_id) {
      try {
        return await this.db.get(project_id, 'project_id');
      } catch (err) {
        winston.error("(wab) Error gettings settings by projectId: ", err);
        return null;
      }
    }
    
    async getSettingsByPhoneNumberId(phone_number_id) {
        try {
            return await this.db.getByField('phone_number_id', phone_number_id);
        } catch(err) {
            return null;
        }
    }

    async getAllSettingsByProjectId(project_id) {
        try {
            return await this.db.getAll(project_id, 'project_id');
        } catch(err) {
            return [];
        }
    }

    async deleteSettings(project_id, waba_id) {
      let CONTENT_KEY = "whatsapp-" + project_id;
      let deleted = await this.db.remove(CONTENT_KEY);
      if (!deleted) {
        CONTENT_KEY = "whatsapp-" + waba_id;
        deleted = await this.db.remove(CONTENT_KEY);
      }
    
      return deleted;
    }
    
    async deleteSettingsByProjectId(project_id) {
      try {
        return await this.db.remove(project_id, 'project_id')
      } catch (err) {
        winston.error("(wab) Error deleting settings by projectId: ", err);
        return false;
      }
    }
}

module.exports = Utils;