var winston = require('../config/winston');

var Recaptcha = require('express-recaptcha').RecaptchaV3;

const recaptcha_key = process.env.RECAPTCHA_KEY;
const recaptcha_secret = process.env.RECAPTCHA_SECRET;
const recaptcha_action = process.env.RECAPTCHA_ACTION || 'submit';
const recaptcha_min_score = Number(process.env.RECAPTCHA_MIN_SCORE || 0.5);
const configured_hostnames = (process.env.RECAPTCHA_HOSTNAMES || '')
    .split(/[;,\s]+/)
    .map(function(hostname) { return hostname.trim().toLowerCase(); })
    .filter(Boolean);

let recaptcha;

let RECAPTCHA_ENABLED =  false;

if (process.env.RECAPTCHA_ENABLED === true || process.env.RECAPTCHA_ENABLED ==="true") {
    RECAPTCHA_ENABLED = true;
    if (recaptcha_key && recaptcha_secret) {
        recaptcha = new Recaptcha(recaptcha_key, recaptcha_secret);
    }
}

winston.info("Recaptcha enabled: " + RECAPTCHA_ENABLED);

module.exports = 
    function(req,res,next){ 
        if (RECAPTCHA_ENABLED==false) {
            return next();
        }

        if (!recaptcha) {
            winston.error('Signup recaptcha is enabled but not configured');
            return res.status(503).send({success: false, msg: 'Recaptcha unavailable.'});
        }

        recaptcha.verify(req, function (error, data) {
            var forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
            var requestHostname = (forwardedHost || req.hostname || req.headers.host || '')
                .split(':')[0]
                .toLowerCase();
            var allowedHostnames = configured_hostnames.length > 0 ? configured_hostnames : [requestHostname];
            var validResult = !error && data &&
                data.action === recaptcha_action &&
                Number.isFinite(Number(data.score)) &&
                Number(data.score) >= recaptcha_min_score &&
                allowedHostnames.indexOf(String(data.hostname || '').toLowerCase()) !== -1;

            if (validResult) {
              winston.debug("Signup recaptcha ok");
              return next();
            } else {
              winston.warn('Signup recaptcha rejected');
              return res.status(403).send({success: false, msg: 'Recaptcha error.'});
            }
        });
}
