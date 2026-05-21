var express = require('express');
const multer  = require('multer');
var passport = require('passport');
require('../middleware/passport')(passport);
var validtoken = require('../middleware/valid-token')
var winston = require('../config/winston');
var pathlib = require('path');
var usageMediaTrafficService = require('../services/usageMediaTrafficService');


var router = express.Router();



const {
  createLegacyFallbackFileServices,
  createPrimaryFileService,
  isObjectStorageEnabled,
} = require('../services/fileStorageServiceFactory');
const { path } = require('../models/tag');

const fileService = createPrimaryFileService("files");
const fallbackFileServices = isObjectStorageEnabled()
  ? createLegacyFallbackFileServices(["files", "images"])
  : createLegacyFallbackFileServices(["images"]);

const usageMediaTraffic = usageMediaTrafficService.createUsageMediaTrafficService();




let MAX_UPLOAD_FILE_SIZE = process.env.MAX_UPLOAD_FILE_SIZE;
let uploadlimits = undefined;

if (MAX_UPLOAD_FILE_SIZE) {
  uploadlimits = {fileSize: parseInt(MAX_UPLOAD_FILE_SIZE)} ;
  winston.info("Max upload file size is : " + MAX_UPLOAD_FILE_SIZE);
} else {
  winston.info("Max upload file size is infinity");
}
const upload = multer({
  storage: isObjectStorageEnabled() ? multer.memoryStorage() : fileService.getStorage("files"),
  limits: uploadlimits
});

function isFileNotFound(error) {
  return error?.code === "ENOENT" || error?.msg === "File not found";
}

async function findFileServiceForPath(filePath) {
  const services = [fileService].concat(fallbackFileServices);

  for (const service of services) {
    try {
      const file = await service.find(filePath);
      return { service, file };
    } catch (error) {
      if (!isFileNotFound(error)) {
        throw error;
      }
    }
  }

  throw { code: "ENOENT", msg: "File not found" };
}

function recordMediaTraffic(req, file, endpoint) {
  usageMediaTraffic.recordServedFileAsync({
    projectId: req.query.id_project || req.projectid,
    path: req.query.path,
    bytes: file && file.length,
    endpoint: endpoint
  });
}

function parseRangeHeader(rangeHeader, fileLength) {
  if (!rangeHeader || !fileLength) {
    return null;
  }

  var match = String(rangeHeader).match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    return { invalid: true };
  }

  var start = match[1] ? parseInt(match[1], 10) : null;
  var end = match[2] ? parseInt(match[2], 10) : null;

  if (start === null && end === null) {
    return { invalid: true };
  }

  if (start === null) {
    if (!end) {
      return { invalid: true };
    }
    start = Math.max(fileLength - end, 0);
    end = fileLength - 1;
  } else if (end === null || end >= fileLength) {
    end = fileLength - 1;
  }

  if (start < 0 || end < start || start >= fileLength) {
    return { invalid: true };
  }

  return {
    start: start,
    end: end,
    length: end - start + 1
  };
}

function streamFileResponse(req, res, service, file, filePath, endpoint) {
  var range = parseRangeHeader(req.headers.range, file && file.length);
  res.set({ "Accept-Ranges": "bytes" });

  if (range && range.invalid) {
    res.set({ "Content-Range": "bytes */" + file.length });
    return res.status(416).send({ success: false, error: "Requested range not satisfiable" });
  }

  if (range) {
    res.status(206);
    res.set({
      "Content-Length": range.length,
      "Content-Type": file.contentType,
      "Content-Range": "bytes " + range.start + "-" + range.end + "/" + file.length
    });
  } else {
    res.set({ "Content-Length": file.length });
    res.set({ "Content-Type": file.contentType });
  }

  recordMediaTraffic(req, file, endpoint);
  var streamOptions = range ? { start: range.start, end: range.end + 1 } : undefined;
  return service.getFileDataAsStream(filePath, streamOptions).on('error', (e)=> {
    if (isFileNotFound(e)) {
      winston.debug('File not found: '+filePath);
      return res.status(404).send({success: false, error: 'File not found.'});
    }
    winston.error('Error getting file', e);
    return res.status(500).send({success: false, error: 'Error getting file.'});
  }).pipe(res);
}

/*
curl -u redacted@example.invalid:123456 \
  -F "file=@/Users/andrealeo/dev/chat21/tiledesk-server-dev-org/README.md" \
  http://localhost:3000/files/users/

  */

// DEPRECATED FROM VERSION 2.14.24
// router.post('/users', [passport.authenticate(['basic', 'jwt'], { session: false }), validtoken], upload.single('file'), (req, res, next) => {

//   winston.verbose("files/users")
//   return res.status(201).json({
//     message: 'File uploded successfully',
//     filename: req.file.filename
//   });

// });

/*
curl \
  -F "file=@/Users/andrealeo/dev/chat21/tiledesk-server-dev-org/README.md" \
  http://localhost:3000/files/public/



  */

// DEPRECATED FROM VERSION 2.14.24
// router.post('/public', upload.single('file'), (req, res, next) => {
//   winston.debug("files/public")
//       return res.status(201).json({
//           message: 'File uploded successfully',
//           filename: req.file.filename
//       });    
// });




router.get("/", async (req, res) => {
  winston.debug('path', req.query.path);
  
  try {
    const { service, file } = await findFileServiceForPath(req.query.path);
    return streamFileResponse(req, res, service, file, req.query.path, 'files.inline');
  } catch (e) {
    if (isFileNotFound(e)) {
      winston.debug(`File ${req.query.path} not found on any configured file service.`)
      return res.status(404).send({ success: false, error: 'File not found.' });
    }
    winston.error('Error getting file', e);
    return res.status(500).send({success: false, error: 'Error getting file.'});
  }
});


router.get("/download", async (req, res) => {
  winston.debug('path', req.query.path);
  let filename = pathlib.basename(req.query.path);
  winston.debug("filename:"+filename);

  try {
    const { service, file } = await findFileServiceForPath(req.query.path);
    res.attachment(filename);
    recordMediaTraffic(req, file, 'files.download');
    return service.getFileDataAsStream(req.query.path).on('error', (e)=> {
      if (isFileNotFound(e)) {
        winston.debug('File not found: '+req.query.path);
        return res.status(404).send({success: false, error: 'File not found.'});
      }
      winston.error('Error getting file', e);
      return res.status(500).send({success: false, error: 'Error getting file.'});
    }).pipe(res);
  } catch (e) {
    if (isFileNotFound(e)) {
      winston.debug(`File ${req.query.path} not found on any configured file service.`)
      return res.status(404).send({ success: false, error: 'File not found.' });
    }
    winston.error('Error getting file', e);
    return res.status(500).send({success: false, error: 'Error getting file.'});
  }
});



module.exports = router;
