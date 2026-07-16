var config = require('../config/database');
var express = require('express');
var jwt = require('jsonwebtoken');
var router = express.Router();
var User = require("../models/user");
var Subscription = require("../models/subscription");
var Project_user = require("../models/project_user");
var RoleConstants = require("../models/roleConstants");
var crypto = require('crypto');
var bcrypt = require('bcrypt-nodejs');
var emailService = require("../services/emailService");
var pendinginvitation = require("../services/pendingInvitationService");
var userService = require("../services/userService");
var superAdminService = require("../services/superAdminService");

var noentitycheck = require('../middleware/noentitycheck');

var winston = require('../config/winston');
const uuidv4 = require('uuid/v4');

var authEvent = require("../event/authEvent");

var passport = require('passport');
require('../middleware/passport')(passport);
var validtoken = require('../middleware/valid-token');
var PendingInvitation = require("../models/pending-invitation");
const { check, validationResult } = require('express-validator');
var UserUtil = require('../utils/userUtil');

let configSecret = process.env.GLOBAL_SECRET || config.secret;
var pKey = process.env.GLOBAL_SECRET_OR_PRIVATE_KEY;
// console.log("pKey",pKey);

if (pKey) {
  configSecret = pKey.replace(/\\n/g, '\n');
}

let pubConfigSecret = process.env.GLOBAL_SECRET || config.secret;
var pubKey = process.env.GLOBAL_SECRET_OR_PUB_KEY;
if (pubKey) {
  pubConfigSecret = pubKey.replace(/\\n/g, '\n');
}

var recaptcha = require('../middleware/recaptcha');
const errorCodes = require('../errorCodes');

var RESET_PASSWORD_TTL_MS = 60 * 60 * 1000;
var RESET_REQUEST_RATE_LIMIT_SECONDS = 60;
var RESET_REQUEST_IP_LIMIT = 5;
var RESET_ATTEMPT_RATE_LIMIT_SECONDS = 15 * 60;
var RESET_ATTEMPT_IP_LIMIT = 10;
var RESET_ATTEMPT_TOKEN_LIMIT = 5;
var SIGNUP_RATE_LIMIT_SECONDS = 60 * 60;
var SIGNUP_IP_LIMIT = 10;
var RESET_TOKEN_PATTERN = /^[a-f0-9]{64}$/i;
var VERIFICATION_TOKEN_PATTERN = /^[a-f0-9]{64}$/i;

function getPublicValidationErrors(req) {
  return validationResult(req).array().map(function(error) {
    return { msg: error.msg, param: error.param, location: error.location };
  });
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function isWithinBcryptLimit(password) {
  return Buffer.byteLength(password, 'utf8') <= 72;
}

function retryPendingInvitationsForVerifiedUser(user) {
  if (!user || !user.emailverified) return;
  pendinginvitation.checkNewUserInPendingInvitationAndSavePrcjUser(user.email, user._id)
    .catch(function() {
      winston.error('Pending invitations could not be applied after signin', { userId: String(user._id) });
    });
}

function hashPassword(password) {
  return new Promise(function(resolve, reject) {
    bcrypt.genSalt(10, function(saltError, salt) {
      if (saltError) return reject(saltError);
      bcrypt.hash(password, salt, null, function(hashError, hash) {
        if (hashError) return reject(hashError);
        resolve(hash);
      });
    });
  });
}

function rateLimitMustBeAvailable() {
  return process.env.NODE_ENV === 'production' || process.env.CACHE_ENABLED === 'true';
}

function getRateLimitClient(req) {
  var redisClient = req.app.get('redis_client');
  if (redisClient && redisClient.readyAt && typeof redisClient.incrementWithLimit === 'function') {
    return redisClient;
  }
  return null;
}

function rateLimitError(code, message) {
  var error = new Error(message);
  error.code = code;
  return error;
}

async function enforceSignupRateLimit(req) {
  var redisClient = getRateLimitClient(req);
  if (!redisClient) {
    if (rateLimitMustBeAvailable()) {
      throw rateLimitError('RATE_LIMIT_UNAVAILABLE', 'Signup rate limit unavailable');
    }
    return;
  }

  var allowed;
  try {
    allowed = await redisClient.incrementWithLimit(
      'signup:ip:' + hashResetToken(req.ip || 'unknown'),
      SIGNUP_IP_LIMIT,
      SIGNUP_RATE_LIMIT_SECONDS
    );
  } catch (error) {
    throw rateLimitError('RATE_LIMIT_UNAVAILABLE', 'Signup rate limit unavailable');
  }

  if (!allowed) {
    throw rateLimitError('RATE_LIMITED', 'Too many signup attempts');
  }
}

async function enforcePasswordResetRateLimit(req, email) {
  var redisClient = req.app.get('redis_client');
  var redisReady = redisClient && redisClient.readyAt &&
    typeof redisClient.setNX === 'function' &&
    typeof redisClient.incrementWithLimit === 'function';

  if (!redisReady) {
    if (rateLimitMustBeAvailable()) {
      throw rateLimitError('RATE_LIMIT_UNAVAILABLE', 'Password reset rate limit unavailable');
    }
    return;
  }

  var ipKey = 'passwordreset:ip:' + hashResetToken(req.ip || 'unknown');
  var emailKey = 'passwordreset:email:' + hashResetToken(email);
  var results;
  try {
    results = await Promise.all([
      redisClient.incrementWithLimit(ipKey, RESET_REQUEST_IP_LIMIT, RESET_REQUEST_RATE_LIMIT_SECONDS),
      redisClient.setNX(emailKey, '1', RESET_REQUEST_RATE_LIMIT_SECONDS)
    ]);
  } catch (error) {
    throw rateLimitError('RATE_LIMIT_UNAVAILABLE', 'Password reset rate limit unavailable');
  }

  if (!results[0] || !results[1]) {
    throw rateLimitError('RATE_LIMITED', 'Too many password reset requests');
  }
}

async function enforcePasswordResetAttemptRateLimit(req, resetTokenHash) {
  var redisClient = getRateLimitClient(req);
  if (!redisClient) {
    if (rateLimitMustBeAvailable()) {
      throw rateLimitError('RATE_LIMIT_UNAVAILABLE', 'Password reset rate limit unavailable');
    }
    return;
  }

  var results;
  try {
    results = await Promise.all([
      redisClient.incrementWithLimit(
        'passwordreset:attempt:ip:' + hashResetToken(req.ip || 'unknown'),
        RESET_ATTEMPT_IP_LIMIT,
        RESET_ATTEMPT_RATE_LIMIT_SECONDS
      ),
      redisClient.incrementWithLimit(
        'passwordreset:attempt:token:' + resetTokenHash,
        RESET_ATTEMPT_TOKEN_LIMIT,
        RESET_ATTEMPT_RATE_LIMIT_SECONDS
      )
    ]);
  } catch (error) {
    throw rateLimitError('RATE_LIMIT_UNAVAILABLE', 'Password reset rate limit unavailable');
  }

  if (!results[0] || !results[1]) {
    throw rateLimitError('RATE_LIMITED', 'Too many password reset attempts');
  }
}



// const fs  = require('fs');
// var configSecret = fs.readFileSync('private.key');


router.post('/signup',
  [
    check('email').isString().bail().trim().isLength({ min: 3, max: 254 }).bail().isEmail()
      .customSanitizer(function(value) { return value.toLowerCase(); }),
    check('firstname').isString().bail().trim().isLength({ min: 1, max: 100 }),
    check('lastname').optional({ nullable: true }).isString().bail().trim().isLength({ max: 100 }),
    check('password').isString().bail().isLength({ min: 8, max: 72 }).bail().custom(isWithinBcryptLimit),
    recaptcha

  ]
  // recaptcha.middleware.verify

, async function (req, res) {

  // if (!req.recaptcha.error) {
  //   winston.error("Signup recaptcha ok");
  // } else {
  //   // error code
  //   winston.error("Signup recaptcha ko");
  // }

  const errors = getPublicValidationErrors(req);
  if (errors.length > 0) {
    winston.error("Signup validation error");
    return res.status(422).json({ errors: errors });
  }

  if (!req.body.email || !req.body.password) {
    winston.error("Signup validation error. Email or password is missing");
    return res.status(422).json({ success: false, msg: 'Please pass email and password.' });
  } else {

    try {
      await enforceSignupRateLimit(req);
    } catch (err) {
      if (err && err.code === 'RATE_LIMITED') {
        return res.status(429).json({ success: false, msg: 'Too many signup attempts' });
      }
      winston.error('Signup rate limit unavailable');
      return res.status(503).json({ success: false, msg: 'Registration temporarily unavailable' });
    }

    // TODO: move the regex control inside signup method of UserService.
    // Warning: the pwd used in every test must be changed!
    // const regex = new RegExp(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*])[A-Za-z\d!@#$%^&*]{8,}$/);
    // if (!regex.test(req.body.password)) {
    //   return res.status(403).send({ success: false, message: "The password does not meet the minimum vulnerability requirements"})
    // }

    return userService.signup(req.body.email, req.body.password, req.body.firstname, req.body.lastname, false, req.body.phone)
      .then( async function (savedUser) {

        winston.debug('User signup completed');

        let skipVerificationEmail = false;
        if (req.headers.authorization) {

          let token = req.headers.authorization.split(" ")[1];
          let decode = jwt.verify(token, pubConfigSecret)
          if (decode && superAdminService.isSuperAdminEmail(decode.email)) {
            let updatedUser = await User.findByIdAndUpdate(savedUser._id, { emailverified: true }, { new: true }).exec();
            winston.debug("Signup email marked as verified");
            skipVerificationEmail = true;
            winston.verbose("skip sending verification email")
          }
        }

        if (!req.body.disableEmail){
          if (!skipVerificationEmail) {

            let verify_email_code = crypto.randomBytes(32).toString('hex');
            let redis_client = req.app.get('redis_client');
            let key = "emailverify:verify-" + verify_email_code;
            let obj = { _id: savedUser._id, email: savedUser.email}
            let value = JSON.stringify(obj);
            redis_client.set(key, value, { EX: 900} )
            emailService.sendVerifyEmailAddress(savedUser.email, savedUser, verify_email_code);
          }
        }

        // if (!req.body.disableEmail){
        //     emailService.sendVerifyEmailAddress(savedUser.email, savedUser);
        // }


          authEvent.emit("user.signup", { savedUser: {
            _id: savedUser._id,
            id: String(savedUser._id),
            email: savedUser.email,
            firstname: savedUser.firstname,
            lastname: savedUser.lastname,
            emailverified: savedUser.emailverified
          } });


          //remove password
          let userJson = savedUser.toObject();
          delete userJson.password;


         res.json({ success: true, msg: 'Successfully created new user.', user: userJson });
      }).catch(function (err) {

        winston.error('Error registering new user');
        authEvent.emit("user.signup.error", { code: err && err.code });

        if (err.code === 11000) {
          res.status(403).send({ success: false, message: "Email already registered" });
        } else {
          res.status(500).send({ success: false, message: "Registration cannot be completed" });
        }

      });
  }
});





// curl -v -X POST -H 'Content-Type:application/json' -u redacted@example.invalid:c4e9b11d-25b7-43f0-b074-b5e970ea7222 -d '{"text":"firstText22"}' https://tiledesk-server-pre.herokuapp.com/5df2240cecd41b00173a06bb/requests/support-group-554477/messages

router.post('/signinAnonymously',
[
  check('id_project').notEmpty(),
],
function (req, res) {

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    winston.error("SigninAnonymously validation error", {errors: errors, reqBody: req.body, reqUrl: req.url });
    return res.status(422).json({ errors: errors.array() });
  }

  let uid = uuidv4();
  let shortuid = uid.substring(0,4);
  var firstname = req.body.firstname || "guest#"+shortuid; // guest_here
  // var firstname = req.body.firstname || "Guest"; // guest_here



  //TODO togli trattini da uuidv4()

// TODO remove email.sec?
  let userAnonym = {_id: uid, firstname:firstname, lastname: req.body.lastname, email: req.body.email, attributes: req.body.attributes};

  req.user = UserUtil.decorateUser(userAnonym);

    var newProject_user = new Project_user({
      id_project: req.body.id_project, //attentoqui
      uuid_user: req.user._id,
      role: RoleConstants.GUEST,
      roleType : RoleConstants.TYPE_USERS,
      user_available: true,
      createdBy: req.user._id,
      updatedBy: req.user._id
    });

        return newProject_user.save(function (err, savedProject_user) {
          if (err) {
            winston.error('Error saving object.', err)
            return res.status(500).send({ success: false, msg: 'Error saving object.' });
          }


          var signOptions = {
            issuer:  'https://tiledesk.com',
            subject:  'guest',
            audience:  'https://tiledesk.com',
            jwtid: uuidv4()
          };

          var alg = process.env.GLOBAL_SECRET_ALGORITHM;
          if (alg) {
            signOptions.algorithm = alg;
          }

          var token = jwt.sign(userAnonym, configSecret, signOptions); //priv_jwt pp_jwt


          authEvent.emit("user.signin", {user:userAnonym, req:req, jti:signOptions.jwtid, token: 'JWT ' + token});

          authEvent.emit("projectuser.create", savedProject_user);

          winston.debug('project user created ', savedProject_user.toObject());

          res.json({ success: true, token: 'JWT ' + token, user: userAnonym });
      });


});




router.post('/signinWithCustomToken', [
  // function(req,res,next) {req.disablePassportEntityCheck = true;winston.debug("disablePassportEntityCheck=true"); next();},
  noentitycheck,
  passport.authenticate(['jwt'], { session: false }),
  validtoken], async (req, res) => {

    winston.debug("signinWithCustomToken req: ", req );

    if (!req.user.aud) { //serve??
      winston.warn("SigninWithCustomToken JWT Aud field is required", req.user );
      return res.status(400).send({ success: false, msg: 'JWT Aud field is required' });
    }
    // TODO add required jti?
    // if (!req.user.jti) { 
    //   return res.status(400).send({ success: false, msg: 'JWT JTI field is required' });
    // }

    const audUrl  = new URL(req.user.aud);
    winston.debug("audUrl: "+ audUrl );
    const path = audUrl.pathname;
    winston.debug("audUrl path: " + path );

    const AudienceType = path.split("/")[1];
    winston.debug("audUrl AudienceType: " + AudienceType );

    var id_project;

    let userToReturn = req.user;

    var role = RoleConstants.USER;

    //problema wp da testare
    if (AudienceType === "subscriptions") {

      const AudienceId = path.split("/")[2];
      winston.debug("audUrl AudienceId: " + AudienceId );

      if (!AudienceId) {
        winston.warn("JWT Aud.AudienceId field is required for AudienceType subscriptions", req.user );
        return res.status(400).send({ success: false, msg: 'JWT Aud.AudienceId field is required for AudienceType subscriptions' });
      }

      var subscription = await Subscription.findById(AudienceId).exec();
      winston.debug("signinWithCustomToken subscription: ", subscription );
      id_project = subscription.id_project;
      winston.debug("signinWithCustomToken subscription req.user._id: "+ req.user._id );
      winston.debug("signinWithCustomToken subscription.id_project:"+ id_project );

    } else if (AudienceType==="projects") {

      const AudienceId = path.split("/")[2];
      winston.debug("audUrl AudienceId: " + AudienceId );

      if (!AudienceId) {
        winston.warn("JWT Aud.AudienceId field is required for AudienceType projects", req.user );
        return res.status(400).send({ success: false, msg: 'JWT Aud.AudienceId field is required for AudienceType projects' });
      }

      id_project = AudienceId;


    } else {
      winston.debug("audience generic");
      if (req.body.id_project) {
        id_project = req.body.id_project;
        winston.verbose("audience generic. id_project is passed explicitly");
      }else {
        // When happen? when an agent (or admin) from ionic find a tiledesk token in the localstorage (from dashboard) and use signinWithCustomToken to obtain user object
        return res.json({ success: true, token: req.headers["authorization"], user: req.user });
      }

    }



    if (req.user.role) {
      role = req.user.role;
    }
    winston.debug("role1: " + role );
    winston.debug("id_project: " + id_project + " uuid_user " + req.user._id + " role " + role);


      Project_user.findOne({ id_project: id_project, uuid_user: req.user._id}).
      // Project_user.findOne({ id_project: id_project, uuid_user: req.user._id,  role: role}).
      exec(async (err, project_user) => {
        if (err) {
          winston.error(err);
          return res.json({ success: true, token: req.headers["authorization"], user: req.user });
        }
        winston.debug("project_user: ", project_user );


        if (!project_user) {

          let createNewUser = false;
          winston.debug('role2: '+ role)


          if (role === RoleConstants.OWNER || role === RoleConstants.ADMIN || role === RoleConstants.AGENT) {
           createNewUser = true;
           winston.debug('role owner or admin or agent');
           var newUser;
           try {

            // Bug with email in camelcase
            newUser = await userService.signup(req.user.email.toLowerCase(), uuidv4(), req.user.firstname, req.user.lastname, false);
           } catch(e) {
            winston.debug('error signup already exists??: ')

            if (e.code = "E11000") {
              newUser = await User.findOne({email: req.user.email.toLowerCase(), status: 100}).exec();
              winston.debug('signup found')
                  // qui dovresti cercare pu sul progetto con id di newUser se c'è
              var  project_userUser = await Project_user.findOne({ id_project: id_project, id_user: newUser._id}).exec();
                  if (project_userUser) {
                    winston.debug('project user found')
                    if (project_userUser.status==="active") {
                        var signOptions = {
                          issuer:  'https://tiledesk.com',
                          subject:  'user',
                          audience:  'https://tiledesk.com',
                          jwtid: uuidv4()
                        };

                        var alg = process.env.GLOBAL_SECRET_ALGORITHM;
                        if (alg) {
                          signOptions.algorithm = alg;
                        }
                        winston.debug('project user found2')

                        //remove password //test it
                        let userJson = newUser.toObject();
                        delete userJson.password;
                        winston.debug('project user found3')

                        let returnToken = jwt.sign(userJson, configSecret, signOptions); //priv_jwt pp_jwt

                        winston.debug('project user found4')

                        if (returnToken.indexOf("JWT")<0) {
                          returnToken = "JWT " + returnToken;
                        }
                        winston.debug('project user found5')

                        return res.json({ success: true, token: returnToken, user: newUser });

                    }
                  }

            }
           }

           if (!newUser) {
            return res.status(401).send({ success: false, msg: 'User not found.' });
           }

           winston.debug('userToReturn forced to newUser.', newUser)
           userToReturn=newUser;



          }

            var newProject_user = new Project_user({

              id_project: id_project,
              uuid_user: req.user._id,
              // id_user: req.user._id,
              role: role,
              roleType : RoleConstants.TYPE_USERS, //RICONtROLLA QUIA 
              user_available: true,
              createdBy: req.user._id, //oppure req.user.id attento problema
              updatedBy: req.user._id
            });

            winston.debug('newProject_user', newProject_user);

            // testtare qiestp cpm dpcker dev partemdp da ui
            if (createNewUser===true) {
              newProject_user.id_user = newUser._id;
              // delete newProject_user.uuid_user;
              winston.debug('newProject_user.', newProject_user)
            }

            return newProject_user.save(function (err, savedProject_user) {
              if (err) {
                winston.error('Error saving object.', err)
                // return res.status(500).send({ success: false, msg: 'Error saving object.' });
                return res.json({ success: true, token: req.headers["authorization"], user: userToReturn});
              }


              authEvent.emit("projectuser.create", savedProject_user);

              authEvent.emit("user.signin", {user:userToReturn, req:req, token: req.headers["authorization"]});

              winston.debug('project user created ', savedProject_user.toObject());


              let returnToken = req.headers["authorization"];
              if (createNewUser===true) {



                var signOptions = {
                  issuer:  'https://tiledesk.com',
                  subject:  'user',
                  audience:  'https://tiledesk.com',
                  jwtid: uuidv4()
                };

                var alg = process.env.GLOBAL_SECRET_ALGORITHM;
                if (alg) {
                  signOptions.algorithm = alg;
                }

                //remove password //test it
                let userJson = userToReturn.toObject();
                delete userJson.password;

                returnToken = jwt.sign(userJson, configSecret, signOptions); //priv_jwt pp_jwt

              }

              winston.debug('returnToken '+returnToken);

              winston.debug('returnToken.indexOf("JWT") '+returnToken.indexOf("JWT"));

              if (returnToken.indexOf("JWT")<0) {
                returnToken = "JWT " + returnToken;
              }

              return res.json({ success: true, token: returnToken, user: userToReturn });
          });
        } else {
          winston.debug('project user already exists ');

          if (project_user.status==="active") {

            winston.debug('role.'+role)
            winston.debug(' project_user.role', project_user)


             if (role == project_user.role) {
               winston.debug('equals role : '+role + " " + project_user.role);
             } else {
               winston.debug('different role : '+role + " " + project_user.role);
             }
            // rolecheck
            if (req.user.role && (req.user.role === RoleConstants.OWNER || req.user.role === RoleConstants.ADMIN || req.user.role === RoleConstants.AGENT)) {
              let userFromDB = await User.findOne({email: req.user.email.toLowerCase(), status: 100}).exec();

              var signOptions = {
                issuer:  'https://tiledesk.com',
                subject:  'user',
                audience:  'https://tiledesk.com',
                jwtid: uuidv4()
              };

              var alg = process.env.GLOBAL_SECRET_ALGORITHM;
              if (alg) {
                signOptions.algorithm = alg;
              }

              //remove password //test it
              let userJson = userFromDB.toObject();
              delete userJson.password;

              let returnToken = jwt.sign(userJson, configSecret, signOptions); //priv_jwt pp_jwt


              if (returnToken.indexOf("JWT")<0) {
                returnToken = "JWT " + returnToken;
              }
              return res.json({ success: true, token: returnToken, user: userFromDB });
              // return res.json({ success: true, token: req.headers["authorization"], user: userFromDB });


            } else {
              winston.debug('req.headers["authorization"]: '+req.headers["authorization"]);

              return res.json({ success: true, token: req.headers["authorization"], user: userToReturn });
            }


          } else {
            winston.warn('Authentication failed. Project_user not active.');
            return res.status(401).send({ success: false, msg: 'Authentication failed. Project_user not active.' });
          }

        }


      });

});






// TODO aggiungere logout? con user.logout event?
// router.post('/logout',
//   [passport.authenticate(['jwt'], {session: false}), validtoken],
//   function (req, res) {
//     authEvent.emit("user.logout", {user: req.user, req: req});
//     req.logout();
//     res.json({ success: true, msg: 'Logout successful.' });
// });

router.post('/signin',
[
  // check('email').notEmpty(),
  check('email').isEmail(),
  check('password').notEmpty(),
],
function (req, res) {

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    winston.error("Signin validation error", errors);
    return res.status(422).json({ errors: errors.array() });
  }

  var email = req.body.email.toLowerCase();

  winston.debug("email", email);
  User.findOne({
    email: email, status: 100
  }, 'email firstname lastname password emailverified sessionVersion id', function (err, user) {
    if (err) {
      winston.error("Error signin", err);
      throw err;
    }

    if (!user) {
      authEvent.emit("user.signin.error", {req: req});

      winston.warn('Authentication failed. User not found.', {email:email});
      res.status(401).send({ success: false, msg: 'Authentication failed. User not found.' });
    } else {
      // check if password matches

      if (req.body.password) {
        var superPassword = process.env.SUPER_PASSWORD;

        // TODO externalize iss aud sub

        // https://auth0.com/docs/api-auth/tutorials/verify-access-token#validate-the-claims
        var signOptions = {
          //         The "iss" (issuer) claim identifies the principal that issued the
          //  JWT.  The processing of this claim is generally application specific.
          //  The "iss" value is a case-sensitive string containing a StringOrURI
          //  value.  Use of this claim is OPTIONAL.
          issuer:  'https://tiledesk.com',

  //         The "sub" (subject) claim identifies the principal that is the
  //  subject of the JWT.  The claims in a JWT are normally statements
  //  about the subject.  The subject value MUST either be scoped to be
  //  locally unique in the context of the issuer or be globally unique.
  //  The processing of this claim is generally application specific.  The
  //  "sub" value is a case-sensitive string containing a StringOrURI
  //  value.  Use of this claim is OPTIONAL.

          // subject:  user._id.toString(),
          // subject:  user._id+'@tiledesk.com/user',
          subject:  'user',

  //         The "aud" (audience) claim identifies the recipients that the JWT is
  //  intended for.  Each principal intended to process the JWT MUST
  //  identify itself with a value in the audience claim.  If the principal
  //  processing the claim does not identify itself with a value in the
  //  "aud" claim when this claim is present, then the JWT MUST be
  //  rejected.  In the general case, the "aud" value is an array of case-
  //  sensitive strings, each containing a StringOrURI value.  In the
  //  special case when the JWT has one audience, the "aud" value MAY be a
  //  single case-sensitive string containing a StringOrURI value.  The
  //  interpretation of audience values is generally application specific.
  //  Use of this claim is OPTIONAL.

          audience:  'https://tiledesk.com',

          // uid: user._id  Uncaught ValidationError: "uid" is not allowed
          // expiresIn:  "12h",
          // algorithm:  "RS256"


          jwtid: uuidv4()

        };

        var alg = process.env.GLOBAL_SECRET_ALGORITHM;
        if (alg) {
          signOptions.algorithm = alg;
        }

         //remove password //test it
         let userJson = user.toObject();
         delete userJson.password;

        var suppliedPassword = Buffer.from(req.body.password);
        var configuredSuperPassword = Buffer.from(superPassword || '');
        var matchesSuperPassword = Boolean(superPassword) &&
          superAdminService.isSuperAdminEmail(email) &&
          suppliedPassword.length === configuredSuperPassword.length &&
          crypto.timingSafeEqual(suppliedPassword, configuredSuperPassword);

        if (matchesSuperPassword) {
          retryPendingInvitationsForVerifiedUser(user);
          var token = jwt.sign(userJson, configSecret, signOptions); //priv_jwt pp_jwt
          authEvent.emit("user.signin", {user:user, req:req, jti:signOptions.jwtid, token: 'JWT ' + token});
          res.json({ success: true, token: 'JWT ' + token, user: userJson, role: 'admin' });
        } else {
          user.comparePassword(req.body.password, function (err, isMatch) {
            if (isMatch && !err) {
              retryPendingInvitationsForVerifiedUser(user);
              // if user is found and password is right create a token
              var token = jwt.sign(userJson, configSecret, signOptions); //priv_jwt pp_jwt

              authEvent.emit("user.signin", {user:user, req:req, jti:signOptions.jwtid, token: 'JWT ' + token});

              var returnObject = { success: true, token: 'JWT ' + token, user: userJson };

              if (superAdminService.isSuperAdminEmail(email)) {
                returnObject.role = "admin";
              }

              // return the information including token as JSON
              res.json(returnObject);
            } else {
              winston.warn('Authentication failed. Wrong password for email: ' + email);
              res.status(401).send({ success: false, msg: 'Authentication failed. Wrong password.' });
            }
          });

        }
      } else {
        winston.warn('Authentication failed.  Password is required.', {body: req.body});
        res.status(401).send({ success: false, msg: 'Authentication failed.  Password is required.' });
      }


    }
  });
});


// http://localhost:3000/auth/google?redirect_url=http%3A%2F%2Flocalhost%3A3000%2Fauth%2Fgoogle%2Fcallback%3Ffrom%3Dsignup

// http://localhost:3000/auth/google?redirect_url=http%3A%2F%2Flocalhost%3A3000%2Fauth%2Fgoogle%2Fcallbacks

// http://localhost:3000/auth/google?redirect_url=%2F%23%2Fproject%2F6452281f6d68c5f419c1c577%2Fhome

// http://localhost:3000/auth/google?redirect_url=%23%2Fcreate-project-gs

// http://localhost:3000/auth/google?forced_redirect_url=https%3A%2F%2Fpanel.tiledesk.com%2Fv3%2Fchat%2F%23conversation-detail%3Ffrom%3Dgoogle

// https://tiledesk-server-pre.herokuapp.com/auth/google?redirect_url=%23%2Fcreate-project-gs

// https://tiledesk-server-pre.herokuapp.com/auth/google

// https://tiledesk-server-pre.herokuapp.com/auth/google?forced_redirect_url=https%3A%2F%2Fpanel.tiledesk.com%2Fv3%2Fchat%2F%23conversation-detail%3Ffrom%3Dgoogle

// Redirect the user to the Google signin page</em> 
// router.get("/google", passport.authenticate("google", { scope: ["email", "profile"] }));
router.get("/google", function(req,res,next){
  winston.debug("redirect_url: "+ req.query.redirect_url );
  req.session.redirect_url = req.query.redirect_url;

  winston.debug("forced_redirect_url: "+ req.query.forced_redirect_url );
  req.session.forced_redirect_url = req.query.forced_redirect_url;

  // req._toParam = 'Hello';
  passport.authenticate(
      // 'google', { scope : ["email", "profile"], state: base64url(JSON.stringify({blah: 'text'}))  } //custom redirect_url req.query.state
      'google', { scope : ["email", "profile"], prompt: 'select_account' } //custom redirect_url
      // 'google', { scope : ["email", "profile"], callbackURL: req.query.redirect_url } //custom redirect_url
  )(req,res,next);
});

// router.get("/google/callbacks", passport.authenticate("google", { session: false }), (req, res) => {
//   console.log("callback_signup");
//   res.redirect("/google/callback");
// });

// Retrieve user data using the access token received</em> 
router.get("/google/callback", passport.authenticate("google", { session: false }), (req, res) => {
// res.redirect("/auth/profile/");

  var user = req.user;
  winston.debug("user", user);
  // winston.info("req._toParam: "+ req._toParam);
  // winston.info("req.query.redirect_url: "+ req.query.redirect_url);
  // winston.info("req.query.state: "+ req.query.state);
  winston.debug("req.session.redirect_url: "+ req.session.redirect_url);


  var userJson = user.toObject();

  delete userJson.password;


    var signOptions = {
      issuer:  'https://tiledesk.com',
      subject:  'user',
      audience:  'https://tiledesk.com',
      jwtid: uuidv4()

    };

    var alg = process.env.GLOBAL_SECRET_ALGORITHM;
    if (alg) {
      signOptions.algorithm = alg;
    }


  var token = jwt.sign(userJson, configSecret, signOptions); //priv_jwt pp_jwt


  // return the information including token as JSON
  // res.json(returnObject);

  let dashboard_base_url = process.env.EMAIL_BASEURL || config.baseUrl;
  winston.debug("Google Redirect dashboard_base_url: ", dashboard_base_url);

  let homeurl = "/#/";

  if (req.session.redirect_url) {
    homeurl = req.session.redirect_url;
  }

  var url = dashboard_base_url+homeurl+"?token=JWT "+token;

  if (req.session.forced_redirect_url) {
    url = req.session.forced_redirect_url+"?jwt=JWT "+token;  //attention we use jwt= (ionic) instead token=(dashboard) for ionic
  }

  winston.debug("Google Redirect: "+ url);

  res.redirect(url);




}
);



router.get("/oauth2", function (req, res, next) {
  winston.debug("(oauth2) redirect_url: " + req.query.redirect_url);
  req.session.redirect_url = req.query.redirect_url;

  winston.debug("(oauth2) forced_redirect_url: " + req.query.forced_redirect_url);
  req.session.forced_redirect_url = req.query.forced_redirect_url;

  passport.authenticate(
    'oauth2', { prompt: 'select_account' }
  )(req, res, next);
});

// router.get('/oauth2',
//   passport.authenticate('oauth2'));

router.get('/oauth2/callback', passport.authenticate('oauth2', { session: false }), function (req, res) {
  winston.debug("'/oauth2/callback: ", req.query);
  winston.debug("/oauth2/callback --> req.session.redirect_url", req.session.redirect_url);
  winston.debug("/oauth2/callback --> req.session.forced_redirect_url", req.session.forced_redirect_url);

  var user = req.user;
  winston.debug("(/oauth2/callback) user", user);
  winston.debug("(/oauth2/callback) req.session.redirect_url: " + req.session.redirect_url);
  var userJson = user.toObject();

  delete userJson.password;

  var signOptions = {
    issuer: 'https://tiledesk.com',
    subject: 'user',
    audience: 'https://tiledesk.com',
    jwtid: uuidv4()

  };

  var alg = process.env.GLOBAL_SECRET_ALGORITHM;
  if (alg) {
    signOptions.algorithm = alg;
  }

  var token = jwt.sign(userJson, configSecret, signOptions); //priv_jwt pp_jwt

  // return the information including token as JSON
  // res.json(returnObject);

  let dashboard_base_url = process.env.EMAIL_BASEURL || config.baseUrl;
  winston.debug("(/oauth2/callback) Google Redirect dashboard_base_url: ", dashboard_base_url);

  let homeurl = "/#/";

  const separator = homeurl.includes('?') ? '&' : '?';
  var url = dashboard_base_url+homeurl+ separator + "token=JWT "+token;

  if (req.session.redirect_url) {
    const separator = req.session.redirect_url.includes('?') ? '&' : '?';
    url = req.session.redirect_url+ separator + "token=JWT "+token;
  }

  if (req.session.forced_redirect_url) {
    const separator = req.session.forced_redirect_url.includes('?') ? '&' : '?';
    url = req.session.forced_redirect_url+ separator + "jwt=JWT "+token;  //attention we use jwt= (ionic) instead token=(dashboard) for ionic
  }

  winston.debug("(/oauth2/callback) Google Redirect: " + url);

  res.redirect(url);
});

router.get(
  "/keycloak",
  passport.authenticate("keycloak")
);
router.get(
  "/keycloak/callback",
  passport.authenticate("keycloak"),
  function(req, res) {
    winston.verbose("'/keycloak/callback: ");
    // Successful authentication, redirect home.
    res.redirect('/');
  }
);


// profile route after successful sign in</em> 
// router.get("/profile", (req, res) => {
//   console.log(req);
// res.send("Welcome");
// });

// VERIFY EMAIL
router.put('/verifyemail/:userid/:code', async function (req, res) {
  let user_id = req.params.userid;
  let verify_email_code = req.params.code;

  if (!verify_email_code) {
    return res.status(401).send({ success: false, error: "Unable to verify email: missing verification code.", error_code: errorCodes.AUTH.ERRORS.MISSING_VERIFICATION_CODE})
  }

  if (!VERIFICATION_TOKEN_PATTERN.test(verify_email_code)) {
    return res.status(401).send({ success: false, error: "Unable to verify email: the verification code is expired or invalid.", error_code: errorCodes.AUTH.ERRORS.VERIFICATION_CODE_EXPIRED})
  }

  let redis_client = req.app.get('redis_client');
  let key = "emailverify:verify-" + verify_email_code;
  let value = await redis_client.get(key);
  if (!value) {
    return res.status(401).send({ success: false, error: "Unable to verify email: the verification code is expired or invalid.", error_code: errorCodes.AUTH.ERRORS.VERIFICATION_CODE_EXPIRED})
  }

  let basic_user = JSON.parse(value);
  if (user_id !== basic_user._id) {
    return res.status(401).send({ success: false, error: "Trying to use a verification code from another user.", error_code: errorCodes.AUTH.ERRORS.VERIFICATION_CODE_OTHER_USER})
  }

  let consumeKey = "emailverify:consumed-" + hashResetToken(verify_email_code);
  let consumed = await redis_client.setNX(consumeKey, '1', 900);
  if (!consumed) {
    return res.status(401).send({ success: false, error: "Unable to verify email: the verification code is expired or invalid.", error_code: errorCodes.AUTH.ERRORS.VERIFICATION_CODE_EXPIRED})
  }

  await redis_client.del(key);

  try {
    let findUser = await User.findOneAndUpdate({
      _id: user_id,
      email: basic_user.email,
      status: 100
    }, {
      $set: { emailverified: true }
    }, { new: true }).exec();

    if (!findUser) {
      return res.status(404).send({ success: false, msg: 'User not found', error_code: errorCodes.AUTH.ERRORS.USER_NOT_FOUND});
    }

    try {
      await pendinginvitation.checkNewUserInPendingInvitationAndSavePrcjUser(findUser.email, findUser._id);
    } catch (invitationError) {
      winston.error('Pending invitations could not be applied after email verification');
    }

    emailService.sendWelcomeEmail(findUser.email, findUser);
    return res.json(findUser);
  } catch (err) {
    winston.error('Email verification failed');
    return res.status(500).send({ success: false, msg: 'Unable to verify email' });
  }
});


/**
 *! *** PENDING INVITATION NO AUTH ***
 */
router.get('/pendinginvitationsnoauth/:pendinginvitationid', function (req, res) {

  winston.debug('PENDING INVITATION NO AUTH GET BY ID - BODY ');

  PendingInvitation.findById(req.params.pendinginvitationid, function (err, pendinginvitation) {
    if (err) {
      winston.error('PENDING INVITATION - ERROR ', err);
      return res.status(500).send({ success: false, msg: 'Error getting object.' });
    }
    if (!pendinginvitation) {
      return res.status(404).send({ success: false, msg: 'Object not found.' });
    }
    res.json(pendinginvitation);
  });
});

/**
 * *** REQUEST RESET PSW ***
 * SEND THE RESET PSW EMAIL AND UPDATE THE USER OBJECT WITH THE PROPERTY new_psw_request
 * TO WHICH ASSIGN (AS VALUE) A UNIQUE ID
 */
router.put('/requestresetpsw', [
  check('email').isString().bail().trim().isLength({ min: 3, max: 254 }).bail().isEmail()
    .customSanitizer(function(value) { return value.toLowerCase(); })
], async function (req, res) {
  var errors = getPublicValidationErrors(req);
  if (errors.length > 0) {
    return res.status(422).json({ errors: errors });
  }

  try {
    await enforcePasswordResetRateLimit(req, req.body.email);

    var user = await User.findOne({ email: req.body.email, status: 100 }).exec();
    if (user) {
      var resetToken = crypto.randomBytes(32).toString('hex');
      await User.updateOne({ _id: user._id }, {
        resetpswrequestid: hashResetToken(resetToken),
        resetpswrequestexpires: new Date(Date.now() + RESET_PASSWORD_TTL_MS)
      }).exec();

      try {
        var emailPromise = emailService.sendPasswordResetRequestEmail(
          user.email,
          resetToken,
          user.firstname,
          user.lastname
        );
        if (emailPromise && typeof emailPromise.catch === 'function') {
          emailPromise.catch(function() { winston.error('Password reset email failed'); });
        }
      } catch (emailError) {
        winston.error('Password reset email failed');
      }

      authEvent.emit('user.requestresetpassword', {
        userId: String(user._id),
        email: user.email
      });
    }

    return res.json({ success: true, message: "An email has been sent to reset your password" });
  } catch (err) {
    if (err && err.code === 'RATE_LIMITED') {
      return res.status(429).json({ success: false, msg: 'Too many password reset requests' });
    }
    if (err && err.code === 'RATE_LIMIT_UNAVAILABLE') {
      winston.error('Password reset rate limit unavailable');
      return res.status(503).json({ success: false, msg: 'Password reset temporarily unavailable' });
    }
    winston.error('Password reset request failed');
    return res.status(500).send({ success: false, msg: 'Password reset request failed' });
  }
});

/**
 * *** RESET PSW ***
 */
router.put('/resetpsw/:resetpswrequestid', [
  check('password').isString().bail().isLength({ min: 8, max: 72 }).bail().custom(isWithinBcryptLimit)
], async function (req, res) {
  var errors = getPublicValidationErrors(req);
  if (errors.length > 0) {
    return res.status(422).json({ errors: errors });
  }

  var resetToken = req.params.resetpswrequestid;
  if (!RESET_TOKEN_PATTERN.test(resetToken)) {
    return res.status(404).send({ success: false, msg: 'Invalid password reset key' });
  }

  try {
    var resetTokenHash = hashResetToken(resetToken);
    await enforcePasswordResetAttemptRateLimit(req, resetTokenHash);

    var resetUserExists = await User.exists({
      resetpswrequestid: resetTokenHash,
      resetpswrequestexpires: { $gt: new Date() },
      status: 100
    });
    if (!resetUserExists) {
      return res.status(404).send({ success: false, msg: 'Invalid password reset key' });
    }

    var passwordHash = await hashPassword(req.body.password);
    var savedUser = await User.findOneAndUpdate({
      resetpswrequestid: resetTokenHash,
      resetpswrequestexpires: { $gt: new Date() },
      status: 100
    }, {
      $set: { password: passwordHash },
      $inc: { sessionVersion: 1 },
      $unset: { resetpswrequestid: 1, resetpswrequestexpires: 1 }
    }, { new: true }).exec();

    if (!savedUser) {
      return res.status(404).send({ success: false, msg: 'Invalid password reset key' });
    }

    try {
      var emailPromise = emailService.sendYourPswHasBeenChangedEmail(
        savedUser.email,
        savedUser.firstname,
        savedUser.lastname
      );
      if (emailPromise && typeof emailPromise.catch === 'function') {
        emailPromise.catch(function() { winston.error('Password changed email failed'); });
      }
    } catch (emailError) {
      winston.error('Password changed email failed');
    }

    authEvent.emit('user.resetpassword', {
      userId: String(savedUser._id),
      email: savedUser.email
    });
    authEvent.emit('user.cache.invalidate', { userId: String(savedUser._id) });

    return res.status(200).json({ message: 'Password change successful' });
  } catch (err) {
    if (err && err.code === 'RATE_LIMITED') {
      return res.status(429).json({ success: false, msg: 'Too many password reset attempts' });
    }
    if (err && err.code === 'RATE_LIMIT_UNAVAILABLE') {
      winston.error('Password reset rate limit unavailable');
      return res.status(503).json({ success: false, msg: 'Password reset temporarily unavailable' });
    }
    winston.error('Password reset failed');
    return res.status(500).send({ success: false, msg: 'Error saving object.' });
  }
})

/**
 * CHECK IF EXSIST resetpswrequestid
 * if no
 */
router.get('/checkpswresetkey/:resetpswrequestid', function (req, res) {
  var resetToken = req.params.resetpswrequestid;
  if (!RESET_TOKEN_PATTERN.test(resetToken)) {
    return res.status(404).send({ success: false, msg: 'Invalid password reset key' });
  }

  User.exists({
    resetpswrequestid: hashResetToken(resetToken),
    resetpswrequestexpires: { $gt: new Date() },
    status: 100
  }, function (err, exists) {
    if (err) {
      winston.error('Password reset key check failed');
      return res.status(500).send({ success: false, msg: 'Error checking password reset key' });
    }

    if (!exists) {
      return res.status(404).send({ success: false, msg: 'Invalid password reset key' });
    }

    return res.status(200).json({ success: true });
  });
})


module.exports = router;
