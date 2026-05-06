const i18next = require('i18next');
const fs = require("fs");
const path = require("path");


class Translator {
  
  constructor(translationsPath) {
    
    this.translationsPath = translationsPath;
    this.resources = this.loadTranslations();
    
    i18next.init({
      fallbackLng: "EN",
      resources: this.resources
    })
    
  }
  
  loadTranslations() {
    const resources = {};
    const files = fs.readdirSync(this.translationsPath);
    
    files.forEach(file => {
      if (file.endsWith('.json')) {
        const lang = path.basename(file, '.json').toUpperCase();
        const filePath = path.join(this.translationsPath, file);
        const translations = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        resources[lang] = { translation: translations };
      }
    })
    return resources;
  }
  
  translate(key, language) {
    return i18next.t(key, { lng: language.toUpperCase() });
  }
  
}

const translator = new Translator(path.join(__dirname, '../assets/i18n'));

module.exports = translator;