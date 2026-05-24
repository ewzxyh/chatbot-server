module.exports = {
  DEFAULT_LANGUAGE: 'pt-BR',
  DEFAULT_TIMEZONE: process.env.CHATCASE_DEFAULT_TIMEZONE || 'America/Sao_Paulo',
  formatDateTime(value) {
    if (!value) {
      return '';
    }

    return new Date(value).toLocaleString(this.DEFAULT_LANGUAGE, {
      timeZone: this.DEFAULT_TIMEZONE
    });
  },
  formatTime(value) {
    if (!value) {
      return '';
    }

    return new Date(value).toLocaleTimeString(this.DEFAULT_LANGUAGE, {
      timeZone: this.DEFAULT_TIMEZONE
    });
  }
};
