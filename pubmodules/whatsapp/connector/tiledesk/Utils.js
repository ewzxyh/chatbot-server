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
        let CONTENT_KEY = "whatsapp-" + project_id;
        let settings;
        settings = await this.db.get(CONTENT_KEY);
        if (!settings) {
          CONTENT_KEY = "whatsapp-" + waba_id;
          settings = await this.db.get(CONTENT_KEY);
        }
      
        return settings;
      }
      
    async getSettingsByProjectId(project_id) {
      try {
        return await this.db.get(project_id, 'project_id');
      } catch (err) {
        winston.error("(wab) Error gettings settings by projectId: ", err);
        return null;
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