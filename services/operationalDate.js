var DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
var UTC_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].indexOf(month) !== -1 ? 30 : 31;
}

function parse(value) {
  if (typeof value !== 'string') return null;
  var match = DATE_ONLY.exec(value) || UTC_DATE_TIME.exec(value);
  if (!match) return null;

  var year = Number(match[1]);
  var month = Number(match[2]);
  var day = Number(match[3]);
  var hour = Number(match[4] || 0);
  var minute = Number(match[5] || 0);
  var second = Number(match[6] || 0);
  var millisecond = Number(match[7] || 0);

  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  var date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  return date;
}

module.exports = {
  parse: parse
};
