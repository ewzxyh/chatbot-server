const listener = require("./listener");

const whatsapp = require("./connector");
const whatsappRoute = whatsapp.router;


module.exports = { listener: listener, whatsappRoute: whatsappRoute }