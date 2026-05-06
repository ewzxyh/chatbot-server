const phonePrefixes = {
  "+1": "EN", // USA, Canada
  "+44": "EN", // UK
  "+33": "FR", // France
  "+34": "ES", // Spain
  "+49": "DE", // Germany
  "+39": "IT", // Italy
  "+81": "JA", // Japan
  "+86": "CH", // China
  "+91": "HI", // India
  "+55": "PT", // Brazil
  "+7": "RU", // Russia
  "+61": "EN", // Australia
  "+966": "AR", // Saudi Arabia
  "+20": "AR", // Egypt
  "+27": "EN", // South Africa
  "+82": "KO", // South Korea
  "+52": "ES", // Mexico
};

class Utils {
  
  async detectLanguageFromPhone(phone_number) {
    
    phone_number = fixNumber(phone_number);
    const sanitizedNumber = phone_number.replace(/[^+\d]/g, "");
    const sortedPrefixes = Object.keys(phonePrefixes).sort(
      (a, b) => b.length - a.length
    );
    const matchedPrefix = sortedPrefixes.find((prefix) =>
      sanitizedNumber.startsWith(prefix)
    );
    if (!matchedPrefix) {
      return "EN";
    }
    return phonePrefixes[matchedPrefix];
  }

  /**
   * Extract error message from axios error, converting it to a string
   * @param {Error} err - The error object
   * @returns {string} - A string representation of the error
   */
  _extractErrorMessage(err) {
    if (!err) {
      return 'Unknown error';
    }

    // If it's an axios error with a response
    if (err.response) {
      const status = err.response.status;
      const statusText = err.response.statusText;
      const data = err.response.data;

      // Try to extract a meaningful message from response.data
      let message = '';
      if (typeof data === 'string') {
        message = data;
      } else if (data && typeof data === 'object') {
        // Try common error message fields
        message = data.message || data.error?.message || data.error || JSON.stringify(data);
      }

      return `HTTP ${status} ${statusText}${message ? ': ' + message : ''}`;
    }

    // If it's an axios error without response (network error, timeout, etc.)
    if (err.request) {
      const code = err.code || '';
      const message = err.message || 'Network error';
      return code ? `${message} (${code})` : message;
    }

    // For other errors, use the message or convert to string
    if (err.message) {
      return err.message;
    }

    // Last resort: convert to string
    return String(err);
  }
  
}

function fixNumber(phone_number) {
  if (phone_number.startsWith("+")) {
    return phone_number;
  } else {
    return "+" + phone_number;
  }
}



let utils = new Utils();

module.exports = utils;
