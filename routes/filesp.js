const express = require('express');
const router = express.Router();
const pathlib = require('path');
const mongoose = require('mongoose');
const multer  = require('multer');
const passport = require('passport');
const mime = require('mime-types');
const path = require('path');
const sharp = require('sharp');
const verifyFileContent = require('../middleware/file-type.js');
const usageMediaTrafficService = require('../services/usageMediaTrafficService');

require('../middleware/passport.js')(passport);
const validtoken = require('../middleware/valid-token.js')
const roleChecker = require('../middleware/has-role.js');
const winston = require('../config/winston.js');
const {
  createLegacyFallbackFileServices,
  createPrimaryFileService,
  isObjectStorageEnabled,
} = require('../services/fileStorageServiceFactory');
const {
  buildAvatarPath,
  buildChatFilePath,
  buildProjectAssetPath,
  buildThumbnailPath,
} = require('../services/fileUploadPathBuilder');
const { createChatImageThumbnail } = require('../services/chatAttachmentThumbnailService');
const roleConstants = require('../models/roleConstants.js');
const faq_kb = require('../models/faq_kb');
const project_user = require('../models/project_user');

const fileService = createPrimaryFileService("files");
const fallbackFileServices = isObjectStorageEnabled()
  ? createLegacyFallbackFileServices(["files", "images"])
  : createLegacyFallbackFileServices(["images"]);
const usageMediaTraffic = usageMediaTrafficService.createUsageMediaTrafficService();


let MAX_UPLOAD_FILE_SIZE = process.env.MAX_UPLOAD_FILE_SIZE || 1024000; // 1MB
let uploadlimits = undefined;

if (MAX_UPLOAD_FILE_SIZE) {
  uploadlimits = { fileSize: parseInt(MAX_UPLOAD_FILE_SIZE) } ;
  winston.info("Max upload file size is : " + MAX_UPLOAD_FILE_SIZE);
} else {
  winston.info("Max upload file size is infinity");
}

/**
 * Default: '2592000' (30 days)
 * Examples:
 * - '30' (30 seconds)
 */
const chatFileExpirationTime = parseInt(process.env.CHAT_FILE_EXPIRATION_TIME || '2592000', 10);

/**
 * Default: ".jpg,.jpeg,.png,.gif,.pdf,.txt"
 * Examples: 
 * - '* /*' without spaces (all extension)
 * Deprecated: "application/pdf,image/png,..."
 */
const default_chat_allowed_extensions = process.env.CHAT_FILES_ALLOW_LIST || ".jpg,.jpeg,.png,.gif,.pdf,.txt"; 
const default_assets_allowed_extensions = process.env.ASSETS_FILES_ALLOW_LIST || ".jpg,.jpeg,.png,.gif,.pdf,.txt,.csv,.doc,.docx"; //,.xls,.xlsx,.ppt,.pptx,.zip,.rar
const images_extensions = [ ".png", ".jpg", ".jpeg", ".gif" ];

function getAllowedExtensions(req, extensionsSource = 'chat') {
  const project = req.project;
  const pu = req.projectuser || {};

  if (extensionsSource === 'avatar') {
    return images_extensions.join(',');
  }
  if (extensionsSource === 'assets') {
    return default_assets_allowed_extensions;
  }
  if (pu.roleType === 2 || pu.role === roleConstants.GUEST) {
    return project?.widget?.allowedUploadExtentions || default_chat_allowed_extensions;
  }
  return project?.settings?.allowed_upload_extentions || default_chat_allowed_extensions;
}

function allowsEveryExtension(allowedExtensions) {
  return String(allowedExtensions || '').trim() === "*/*";
}

function shouldVerifyUploadedContent(req, extensionsSource = 'chat') {
  if (extensionsSource === 'avatar') {
    return true;
  }
  return !allowsEveryExtension(getAllowedExtensions(req, extensionsSource));
}

async function verifyUploadedContent(req, buffer, mimetype, extensionsSource = 'chat') {
  if (!shouldVerifyUploadedContent(req, extensionsSource)) {
    return true;
  }
  return verifyFileContent(buffer, mimetype);
}

const fileFilter = (extensionsSource = 'chat') => {
  return (req, file, cb) => {

    const allowed_extensions = getAllowedExtensions(req, extensionsSource);
    let allowed_mime_types;

    if (allowed_extensions !== "*/*") {
      allowed_mime_types = getMimeTypes(allowed_extensions);
      if (!file.originalname) {
        return cb(new Error("File original name is required"));
      }
      const ext = path.extname(file.originalname).toLowerCase();

      if (!allowed_extensions.includes(ext)) {
        const error = new Error(`File extension ${ext} is not allowed${extensionsSource === 'avatar' ? ' for avatar' : ''}`);
        error.status = 403;
        return cb(error);
      }

      const expectedMimeType = mime.lookup(ext);
      if (expectedMimeType && !areMimeTypesEquivalent(file.mimetype, expectedMimeType)) {
        const error = new Error(`File content does not match mimetype. Detected: ${file.mimetype}, provided: ${expectedMimeType}`);
        error.status = 403;
        return cb(error);
      }

      return cb(null, true);
    } else {
      return cb(null, true);
    }
  }
}

function getMimeTypes(allowed_extension) {
  const extension = allowed_extension.split(',').map(e => e.trim().toLowerCase());
  const allowedMimeTypes = extension.map(ext => mime.lookup(ext)).filter(Boolean);
  return allowedMimeTypes;
}

/**
 * Checks if two MIME types are equivalent, accepting common aliases
 * Examples:
 * - audio/wav === audio/wave
 * - audio/x-wav === audio/wave
 * - image/jpeg === image/jpg
 */
function areMimeTypesEquivalent(mimeType1, mimeType2) {
  if (!mimeType1 || !mimeType2) return false;
  if (mimeType1 === mimeType2) return true;
  
  // Normalize to lowercase for comparison
  const m1 = mimeType1.toLowerCase();
  const m2 = mimeType2.toLowerCase();
  if (m1 === m2) return true;
  
  // Common MIME type aliases
  const aliases = {
    'audio/wav': ['audio/wave', 'audio/x-wav', 'audio/vnd.wave'],
    'audio/wave': ['audio/wav', 'audio/x-wav', 'audio/vnd.wave'],
    'audio/x-wav': ['audio/wav', 'audio/wave', 'audio/vnd.wave'],
    'audio/vnd.wave': ['audio/wav', 'audio/wave', 'audio/x-wav'],
    'audio/mpeg': ['audio/opus', 'audio/mp3', 'audio/webm'],
    'audio/mp3': ['audio/mpeg', 'audio/opus', 'audio/webm'],
    'audio/opus': ['audio/mpeg', 'audio/mp3', 'audio/webm'],
    'audio/webm': ['audio/mpeg', 'audio/mp3', 'audio/opus'],
    'image/jpeg': ['image/jpg'],
    'image/jpg': ['image/jpeg'],
    'application/x-zip-compressed': ['application/zip'],
    'application/zip': ['application/x-zip-compressed'],
  };
  
  // Check if m1 is an alias of m2 or vice versa
  if (aliases[m1] && aliases[m1].includes(m2)) return true;
  if (aliases[m2] && aliases[m2].includes(m1)) return true;
  
  return false;
}

const uploadChat = multer({
  storage: isObjectStorageEnabled() ? multer.memoryStorage() : fileService.getStorage("files"),
  fileFilter: fileFilter('chat'),
  limits: uploadlimits
}).single('file');

const uploadAssets = multer({
  storage: isObjectStorageEnabled() ? multer.memoryStorage() : fileService.getStorageProjectAssets("files"),
  fileFilter: fileFilter('assets'),
  limits: uploadlimits
}).single('file');

const uploadAvatar = multer({
  storage: isObjectStorageEnabled() ? multer.memoryStorage() : fileService.getStorageAvatarFiles("files"),
  fileFilter: fileFilter('avatar'),
  limits: uploadlimits
}).single('file');

function shouldUseObjectStorage() {
  return fileService.storageType === 'r2';
}

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

async function deleteFileIfExists(service, filePath) {
  try {
    await service.deleteFile(filePath);
  } catch (error) {
    if (!isFileNotFound(error)) {
      throw error;
    }
  }
}

async function setGridFsExpiration(file, expireAt) {
  const fileId = file && (file.id || file._id);
  if (!fileId || !expireAt) {
    return;
  }

  await mongoose.connection.db.collection('files.chunks').updateMany(
    { files_id: fileId },
    { $set: { "metadata.expireAt": expireAt }}
  );
}

async function createObjectStorageFile(filename, buffer, contentType, metadata) {
  await fileService.createFile(
    filename,
    buffer,
    undefined,
    contentType,
    metadata ? { metadata } : undefined
  );
}

function recordMediaTraffic(req, file, endpoint) {
  usageMediaTraffic.recordServedFileAsync({
    projectId: req.query.id_project || req.projectid,
    path: req.query.path,
    bytes: file && file.length,
    endpoint: endpoint
  });
}


// *********************** //
// ****** Endpoints ****** //
// *********************** //

router.post('/chat', [
  passport.authenticate(['basic', 'jwt'], { session: false }),
  validtoken,
  roleChecker.hasRoleOrTypes('guest', ['bot','subscription'])
], async (req, res) => {

  const expireAt = new Date(Date.now() + chatFileExpirationTime * 1000);
  req.expireAt = expireAt;
  uploadChat(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      // A Multer error occurred when uploading
      winston.error(`Multer replied with code ${err?.code} and message "${err?.message}"`);
      let status = 400;
      if (err?.code === 'LIMIT_FILE_SIZE') {
        status = 413;
      }
      return res.status(status).send({ success: false, error: err?.message || 'An error occurred while uploading the file', code: err.code });
    } else if (err) {
      // An unknown error occurred when uploading.
      winston.error(`Multer replied with status ${err?.status} and message "${err?.message}"`);
      let status = err?.status || 400;
      return res.status(status).send({ success: false, error: err.message || "An error occurred while uploading the file" })
    }
    try {
      if (!req.file) {
        return res.status(400).send({ success: false, error: 'No file uploaded' });
      }

      if (shouldUseObjectStorage()) {
        const filename = buildChatFilePath({
          userId: req.user && req.user.id,
          folderName: "files",
          originalname: req.file.originalname,
        });
        await verifyUploadedContent(req, req.file.buffer, req.file.mimetype, 'chat');
        await createObjectStorageFile(filename, req.file.buffer, req.file.mimetype, { expireAt });
        let thumbnail;
        try {
          thumbnail = await createChatImageThumbnail({
            filename,
            buffer: req.file.buffer,
            mimetype: req.file.mimetype,
            expireAt,
            storeThumbnail: createObjectStorageFile,
          });
        } catch (thumbErr) {
          winston.error("Error generating chat thumbnail", thumbErr);
        }

        return res.status(201).send({ message: "File uploaded successfully", filename, thumbnail });
      }

      const buffer = await fileService.getFileDataAsBuffer(req.file.filename);
      await verifyUploadedContent(req, buffer, req.file.mimetype, 'chat');
      await setGridFsExpiration(req.file, req.file.metadata && req.file.metadata.expireAt);
      let thumbnail;
      try {
        thumbnail = await createChatImageThumbnail({
          fileService,
          filename: req.file.filename,
          buffer,
          mimetype: req.file.mimetype,
          expireAt: req.file.metadata && req.file.metadata.expireAt,
          setExpiration: setGridFsExpiration,
        });
      } catch (thumbErr) {
        winston.error("Error generating chat thumbnail", thumbErr);
      }

      return res.status(201).send({ message: "File uploaded successfully", filename: req.file.filename, thumbnail })
    } catch (err) {
      if (err?.source === "FileContentVerification") {
        let error_message = err?.message || "Content verification failed";
        winston.warn("File content verification failed. Message: ", error_message);
        return res.status(403).send({ success: false, error: error_message })
      }
      winston.error("Error saving file: ", err);
      return res.status(500).send({ success: false, error: "Error updating file chunks" });
    }
  })

})


router.post('/assets', [
  passport.authenticate(['basic', 'jwt'], { session: false }),
  validtoken,
  roleChecker.hasRoleOrTypes('admin', ['bot','subscription'])
], async (req, res) => {
  // Assets have no retention by default, but can be set via query parameter
  let customExpiration = parseInt(req.query?.expiration, 10);
  if (customExpiration && !isNaN(customExpiration) && customExpiration > 0) {
    req.expireAt = new Date(Date.now() + customExpiration * 1000);
  }


  uploadAssets(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      // A Multer error occurred when uploading
      winston.error(`Multer replied with code ${err?.code} and message "${err?.message}"`);
      let status = 400;
      if (err?.code === 'LIMIT_FILE_SIZE') {
        status = 413;
      }
      return res.status(status).send({ success: false, error: err?.message || 'An error occurred while uploading the file', code: err.code });
    } else if (err) {
      // An unknown error occurred when uploading.
      winston.error(`Multer replied with status ${err?.status} and message "${err?.message}"`);
      let status = err?.status || 400;
      return res.status(status).send({ success: false, error: err.message || "An error occurred while uploading the file" })
    }

    try {
      if (!req.file) {
        return res.status(400).send({ success: false, error: 'No file uploaded' });
      }

      if (shouldUseObjectStorage()) {
        const projectId = req.project && req.project._id
          ? req.project._id.toString()
          : req.projectid && req.projectid.toString();
        const filename = buildProjectAssetPath({
          projectId,
          folderName: "files",
          originalname: req.file.originalname,
        });
        const metadata = req.expireAt ? { expireAt: req.expireAt } : undefined;
        await verifyUploadedContent(req, req.file.buffer, req.file.mimetype, 'assets');
        await createObjectStorageFile(filename, req.file.buffer, req.file.mimetype, metadata);

        const ext = path.extname(req.file.originalname).toLowerCase();
        let thumbnail;
        if (images_extensions.includes(ext)) {
          thumbnail = buildThumbnailPath(filename);
          const resized = await sharp(req.file.buffer).resize(200, 200).toBuffer();
          await createObjectStorageFile(thumbnail, resized, req.file.mimetype, metadata);
        }

        return res.status(201).send({
          message: 'File uploaded successfully',
          filename: encodeURIComponent(filename),
          thumbnail: thumbnail ? encodeURIComponent(thumbnail) : undefined
        });
      }

      const buffer = await fileService.getFileDataAsBuffer(req.file.filename);
      await verifyUploadedContent(req, buffer, req.file.mimetype, 'assets');

      if (req.file.metadata && req.file.metadata.expireAt) {
        await setGridFsExpiration(req.file, req.file.metadata.expireAt);
      }

      const ext = path.extname(req.file.originalname).toLowerCase();
      let thumbnail;

      // Generate thumbnail for images
      if (images_extensions.includes(ext)) {
        const buffer = await fileService.getFileDataAsBuffer(req.file.filename);
        const thumbFilename = req.file.filename.replace(/([^/]+)$/, "thumbnails_200_200-$1");
        const resized = await sharp(buffer).resize(200, 200).toBuffer();
        
        const thumbMetadata = req.expireAt ? { metadata: { expireAt: req.expireAt } } : undefined;
        // Use the same contentType as the original file for the thumbnail
        await fileService.createFile(thumbFilename, resized, undefined, req.file.mimetype, thumbMetadata);
        
        if (req.expireAt) {
          await setGridFsExpiration(await fileService.find(thumbFilename), req.expireAt);
        }
        thumbnail = thumbFilename;
      }

      return res.status(201).send({
        message: 'File uploaded successfully',
        filename: encodeURIComponent(req.file.filename),
        thumbnail: thumbnail ? encodeURIComponent(thumbnail) : undefined
      })

    } catch (err) {
      if (err?.source === "FileContentVerification") {
        let error_message = err?.message || "Content verification failed";
        winston.warn("File content verification failed. Message: ", error_message);
        return res.status(403).send({ success: false, error: error_message })
      }

      winston.error("Error uploading asset", err);
      return res.status(500).send({ success: false, error: "Error uploading asset" });

    }
  })
})

/**
 * Upload user profile photo or bot avatar
 * Path: uploads/users/{user_id|bot_id}/images/photo.jpg
 * This maintains compatibility with clients that expect fixed paths.
 * Profile photos/avatars have no retention.
 */
router.post('/users/photo', [
  passport.authenticate(['basic', 'jwt'], { session: false }),
  validtoken,
  roleChecker.hasRoleOrTypes('agent', ['bot','subscription'])
], async (req, res) => {

  uploadAvatar(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      // A Multer error occurred when uploading
      winston.error(`Multer replied with code ${err?.code} and message "${err?.message}"`);
      let status = 400;
      if (err?.code === 'LIMIT_FILE_SIZE') {
        status = 413;
      }
      return res.status(status).send({ success: false, error: err?.message || 'An error occurred while uploading the file', code: err.code });
    } else if (err) {
      // An unknown error occurred when uploading.
      winston.error(`Multer replied with status ${err?.status} and message "${err?.message}"`);
      let status = err?.status || 400;
      return res.status(status).send({ success: false, error: err.message || "An error occurred while uploading the file" })
    }

    try {
      winston.debug("/users/photo");
  
      if (!req.file) {
        return res.status(400).send({ success: false, error: 'No file uploaded' });
      }
  
      let userid = req.user.id;
      let bot_id;
      let entity_id = userid;
  
      if (req.query.bot_id) {
        bot_id = req.query.bot_id;
  
        let chatbot = await faq_kb.findById(bot_id).catch((err) => {
          winston.error("Error finding bot ", err);
          return res.status(500).send({ success: false, error: "Unable to find chatbot with id " + bot_id });
        });
  
        if (!chatbot) {
          return res.status(404).send({ success: false, error: "Chatbot not found" });
        }
  
        let id_project = chatbot.id_project;
  
        let puser = await project_user.findOne({ id_user: userid, id_project: id_project }).catch((err) => {
          winston.error("Error finding project user: ", err);
          return res.status(500).send({ success: false, error: "Unable to find project user for user " + userid + "in project " + id_project });
        });
  
        if (!puser) {
          winston.warn("User " + userid + " doesn't belong to the project " + id_project);
          return res.status(401).send({ success: false, error: "You don't belong to the chatbot's project" });
        }
  
        if ((puser.role !== roleConstants.ADMIN) && (puser.role !== roleConstants.OWNER)) {
          winston.warn("User with role " + puser.role + " can't modify the chatbot");
          return res.status(403).send({ success: false, error: "You don't have the role required to modify the chatbot" });
        }
  
        entity_id = bot_id;
      }
  
      const targetFilename = buildAvatarPath({ entityId: entity_id });
      const thumFilename = buildThumbnailPath(targetFilename);

      if (shouldUseObjectStorage()) {
        await verifyFileContent(req.file.buffer, req.file.mimetype);
        await deleteFileIfExists(fileService, targetFilename);
        await deleteFileIfExists(fileService, thumFilename);
        await createObjectStorageFile(targetFilename, req.file.buffer, req.file.mimetype);

        try {
          const resizeImage = await sharp(req.file.buffer).resize(200, 200).toBuffer();
          await createObjectStorageFile(thumFilename, resizeImage, req.file.mimetype);

          return res.status(201).json({
            message: 'Image uploaded successfully',
            filename: encodeURIComponent(targetFilename),
            thumbnail: encodeURIComponent(thumFilename)
          });
        } catch (thumbErr) {
          winston.error("Error generating or creating thumbnail", thumbErr);
          return res.status(201).json({
            message: 'Image uploaded successfully',
            filename: encodeURIComponent(targetFilename),
            thumbnail: undefined
          });
        }
      }
  
      winston.debug("req.file.filename:" + req.file.filename);
      const buffer = await fileService.getFileDataAsBuffer(req.file.filename);
  
      try {
        const resizeImage = await sharp(buffer).resize(200, 200).toBuffer();
        // Use the same contentType as the original file for the thumbnail
        await fileService.createFile(thumFilename, resizeImage, undefined, req.file.mimetype);
        let thumFile = await fileService.find(thumFilename);
        winston.debug("thumFile", thumFile);
  
        return res.status(201).json({
          message: 'Image uploaded successfully',
          filename: encodeURIComponent(req.file.filename),
          thumbnail: encodeURIComponent(thumFilename)
        });
      } catch (thumbErr) {
        winston.error("Error generating or creating thumbnail", thumbErr);
        // Still return success for the main file, but log thumbnail error
        return res.status(201).json({
          message: 'Image uploaded successfully',
          filename: encodeURIComponent(req.file.filename),
          thumbnail: undefined
        });
      }
  
    } catch (error) {
      if (error?.source === "FileContentVerification") {
        let error_message = error?.message || "Content verification failed";
        winston.warn("File content verification failed. Message: ", error_message);
        return res.status(403).send({ success: false, error: error_message });
      }
      winston.error('Error uploading user image.', error);
      return res.status(500).send({ success: false, error: 'Error uploading user image.' });
    }

  })
})


router.get("/", [
  passport.authenticate(['basic', 'jwt'], { session: false }), 
  validtoken,
], async (req, res) => {
  winston.debug('path', req.query.path);

  if (req.query.as_attachment) {
    res.set({ "Content-Disposition": "attachment; filename=\""+req.query.path+"\"" });
  }
  
  try {
    const { service, file } = await findFileServiceForPath(req.query.path);
    res.set({ "Content-Length": file.length});
    res.set({ "Content-Type": file.contentType});
    recordMediaTraffic(req, file, 'project_files.inline');
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

router.get("/download", [
  passport.authenticate(['basic', 'jwt'], { session: false }), 
  validtoken,
], async (req, res) => {
  winston.debug('path', req.query.path);

  let filename = pathlib.basename(req.query.path);
  winston.debug("filename:"+filename);

  try {
    const { service, file } = await findFileServiceForPath(req.query.path);
    res.attachment(filename);
    recordMediaTraffic(req, file, 'project_files.download');
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

/**
 * Delete a file (and its thumbnail if it's an image)
 * Works for both profile photos/avatars and project assets
 * 
 * Example:
 * curl -v -X DELETE -u user:pass \
 *   http://localhost:3000/filesp?path=uploads%2Fusers%2F65c5f3599faf2d04cd7da528%2Fimages%2Fphoto.jpg
 * 
 * curl -v -X DELETE -u user:pass \
 *   http://localhost:3000/filesp?path=uploads%2Fprojects%2F65c5f3599faf2d04cd7da528%2Ffiles%2Fuuid%2Flogo.png
 */
router.delete("/", [
  passport.authenticate(['basic', 'jwt'], { session: false }), 
  validtoken,
], async (req, res) => {
  try {
    winston.debug("delete file");
    
    let filePath = req.query.path;
    if (!filePath) {
      return res.status(400).send({ success: false, error: 'Path parameter is required' });
    }
    
    winston.debug("path:" + filePath);

    let filename = pathlib.basename(filePath);
    winston.debug("filename:" + filename);

    if (!filename) {
      winston.warn('Error deleting file. No filename specified:' + filePath);
      return res.status(400).send({ success: false, error: 'No filename specified in path' });
    }

    try {
      const { service: fService } = await findFileServiceForPath(filePath);

      // Delete the main file
      const deletedFile = await fService.deleteFile(filePath);
      winston.debug("File deleted successfully:", deletedFile.filename);

      // Check if this is an image and try to delete thumbnail
      // Thumbnail pattern: thumbnails_200_200-{filename}
      // For profile photos: thumbnails_200_200-photo.jpg
      // For assets: thumbnails_200_200-{original_filename}
      const isImage = images_extensions.some(ext => filename.toLowerCase().endsWith(ext));
      
      if (isImage) {
        let thumbFilename = 'thumbnails_200_200-' + filename;
        let thumbPath = filePath.replace(filename, thumbFilename);
        winston.debug("thumbPath:" + thumbPath);

        const services = [fService]
          .concat([fileService].concat(fallbackFileServices).filter((service) => service !== fService));

        for (const service of services) {
          try {
            await service.deleteFile(thumbPath);
            winston.debug("Thumbnail deleted successfully:" + thumbPath);
            break;
          } catch (thumbErr) {
            if (!isFileNotFound(thumbErr)) {
              winston.error('Error deleting thumbnail:', thumbErr);
              break;
            }
          }
        }
      }

      return res.status(200).json({
        message: 'File deleted successfully',
        filename: encodeURIComponent(deletedFile.filename)
      });

    } catch (deleteErr) {
      if (isFileNotFound(deleteErr)) {
        winston.debug(`File ${filePath} not found on any configured file service.`);
        return res.status(404).send({ success: false, error: 'File not found.' });
      }
      winston.error('Error deleting file:', deleteErr);
      return res.status(500).send({ success: false, error: 'Error deleting file.' });
    }

  } catch (error) {
    winston.error('Error in delete endpoint:', error);
    return res.status(500).send({ success: false, error: 'Error deleting file.' });
  }
});


router.__test = {
  allowsEveryExtension,
  getAllowedExtensions,
  shouldVerifyUploadedContent,
  verifyUploadedContent
};

module.exports = router;
