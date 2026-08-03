var axios = require('axios');
var pathlib = require('path');
var mime = require('mime-types');
var FileType = require('file-type');
var configGlobal = require('../../config/global');
var winston = require('../../config/winston');

var {
  createPrimaryFileService
} = require('../../services/fileStorageServiceFactory');
var {
  buildChatFilePath
} = require('../../services/fileUploadPathBuilder');
var {
  createChatImageThumbnail
} = require('../../services/chatAttachmentThumbnailService');
var mediaCdnUrlService = require('../../services/mediaCdnUrlService');
var verifyFileContent = require('../../middleware/file-type.js');
var operationalLogger = require('../../services/operationalLogger');

var defaultFileService;

function getDefaultFileService() {
  if (!defaultFileService) {
    defaultFileService = createPrimaryFileService('files');
  }
  return defaultFileService;
}

function getBaseFileUrl(options) {
  var baseFileUrl = options && options.baseFileUrl;
  if (!baseFileUrl) {
    baseFileUrl = process.env.BASE_FILE_URL || process.env.API_URL;
  }
  if (!baseFileUrl && process.env.EXTERNAL_BASE_URL) {
    baseFileUrl = process.env.EXTERNAL_BASE_URL.replace(/\/+$/, '') + '/api';
  }
  return String(baseFileUrl || configGlobal.apiUrl || 'http://localhost:3000').replace(/\/+$/, '');
}

function isHttpUrl(value) {
  try {
    var url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (err) {
    return false;
  }
}

function isLocalFileUrl(sourceUrl, baseFileUrl) {
  try {
    var source = new URL(sourceUrl);
    var base = new URL(baseFileUrl);
    var basePath = base.pathname.replace(/\/+$/, '');
    return source.origin === base.origin && source.pathname.indexOf(basePath + '/files') === 0;
  } catch (err) {
    return false;
  }
}

function shouldPersistExternalMedia(mapped, baseFileUrl) {
  return Boolean(
    mapped &&
    mapped.metadata &&
    mapped.metadata.src &&
    isHttpUrl(mapped.metadata.src) &&
    !isLocalFileUrl(mapped.metadata.src, baseFileUrl) &&
    (mapped.type === 'image' || mapped.type === 'frame' || mapped.type === 'file' || mapped.type === 'sticker')
  );
}

function cleanContentType(value) {
  if (!value) {
    return undefined;
  }
  return String(value).split(';')[0].trim().toLowerCase() || undefined;
}

function validMime(value) {
  value = cleanContentType(value);
  return value && value.indexOf('/') > 0 ? value : undefined;
}

function extensionFromType(contentType, mapped) {
  var ext = contentType && mime.extension(contentType);
  if (ext) {
    return '.' + ext;
  }
  if (mapped.type === 'image') {
    return '.jpg';
  }
  if (mapped.type === 'sticker') {
    return '.webp';
  }
  if (mapped.type === 'frame') {
    return '.mp4';
  }
  return '';
}

function filenameMatchesContentType(name, contentType) {
  if (!name || !contentType) {
    return true;
  }
  return validMime(mime.lookup(name)) === contentType;
}

function normalizeFilenameExtension(name, contentType, mapped) {
  if (!name || filenameMatchesContentType(name, contentType)) {
    return name;
  }

  var ext = extensionFromType(contentType, mapped);
  if (!ext) {
    return name;
  }
  return name.replace(/\.[^/.]+$/, '') + ext;
}

function sanitizeFilename(name) {
  var safe = pathlib.basename(String(name || 'media').replace(/\\/g, '/'));
  safe = safe.replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').trim();
  return safe || 'media';
}

function filenameFromUrl(sourceUrl) {
  try {
    var pathname = decodeURIComponent(new URL(sourceUrl).pathname || '');
    return sanitizeFilename(pathname);
  } catch (err) {
    return 'media';
  }
}

function originalFilename(mapped, sourceUrl, contentType) {
  var metadata = mapped.metadata || {};
  var name = metadata.name || filenameFromUrl(sourceUrl);
  name = sanitizeFilename(name);

  if (!pathlib.extname(name)) {
    name += extensionFromType(contentType, mapped);
  }
  return normalizeFilenameExtension(name, contentType, mapped);
}

async function detectContentType(buffer) {
  try {
    var detected = await FileType.fromBuffer(buffer);
    return detected && detected.mime ? cleanContentType(detected.mime) : undefined;
  } catch (err) {
    return undefined;
  }
}

function canTrustDetectedContentType(mapped, detectedContentType) {
  if (!detectedContentType) {
    return false;
  }
  if (mapped.type === 'image') {
    return detectedContentType.indexOf('image/') === 0;
  }
  if (mapped.type === 'frame') {
    return detectedContentType.indexOf('video/') === 0;
  }
  if (mapped.type === 'sticker') {
    return detectedContentType.indexOf('image/') === 0;
  }
  return true;
}

function publicFileUrls(filename, baseFileUrl, projectId, options) {
  var env = options && options.mediaCdnEnv ? options.mediaCdnEnv : process.env;
  return mediaCdnUrlService.buildMediaUrls({
    filename: filename,
    baseFileUrl: baseFileUrl,
    projectId: projectId,
    env: env,
    preferCdnUrl: mediaCdnUrlService.replaceSrcEnabled(env)
  });
}

function maxMediaBytes(options) {
  var value = options && options.maxBytes;
  if (!value) {
    value = process.env.CASEZAP_MEDIA_MAX_BYTES || 25 * 1024 * 1024;
  }
  return parseInt(value, 10);
}

function refreshAudioMarker(text, metadata) {
  if (typeof text !== 'string' || text.indexOf('[casezap-audio:') !== 0) {
    return text;
  }
  return text.replace(/^\[casezap-audio:([A-Za-z0-9+/=]+)\]/, function(full, encoded) {
    try {
      var payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      payload.src = metadata.src || payload.src;
      payload.downloadUrl = metadata.downloadUrl || payload.downloadUrl;
      payload.mimeType = metadata.type || payload.mimeType;
      return '[casezap-audio:' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64') + ']';
    } catch (err) {
      return full;
    }
  });
}

function headerValue(headers, name) {
  if (!headers) {
    return undefined;
  }
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()];
}

function parseContentLength(headers) {
  var value = headerValue(headers, 'content-length');
  if (!value) {
    return undefined;
  }
  var parsed = parseInt(value, 10);
  return isNaN(parsed) ? undefined : parsed;
}

function isMaxSizeExceededError(err) {
  var message = err && err.message ? String(err.message) : '';
  return Boolean(
    err &&
    (
      /maxContentLength/i.test(message) ||
      /maxBodyLength/i.test(message) ||
      err.code === 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED'
    )
  );
}

function externalOnlyMediaResult(mapped, sourceUrl, reason, headers) {
  var metadata = mapped.metadata || {};
  var contentType = validMime(headerValue(headers, 'content-type')) ||
    validMime(metadata.type) ||
    validMime(mime.lookup(metadata.name || filenameFromUrl(sourceUrl))) ||
    'application/octet-stream';
  var name = originalFilename(mapped, sourceUrl, contentType);

  return {
    filename: name,
    url: sourceUrl,
    downloadUrl: sourceUrl,
    sourceUrl: sourceUrl,
    contentType: contentType,
    externalOnly: true,
    rehostSkipped: true,
    rehostReason: reason,
    size: parseContentLength(headers)
  };
}

function wait(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
}

async function waitForFileServiceReady(fileService) {
  if (!fileService || !fileService.conn || fileService.gfs || fileService.storageType === 'r2') {
    return;
  }

  for (var i = 0; i < 50; i++) {
    if (fileService.gfs) {
      return;
    }
    await wait(100);
  }

  throw new Error('File storage is not ready');
}

async function downloadExternalMedia(sourceUrl, options) {
  if (!isHttpUrl(sourceUrl)) {
    throw new Error('Unsupported media URL');
  }

  var maxBytes = maxMediaBytes(options || {});
  var httpClient = (options && options.httpClient) || axios;
  var response = await httpClient.get(sourceUrl, {
    responseType: 'arraybuffer',
    timeout: 15000,
    maxContentLength: maxBytes,
    maxBodyLength: maxBytes,
    headers: { Accept: '*/*' }
  });

  return {
    buffer: Buffer.from(response.data || []),
    contentType: cleanContentType(response.headers && response.headers['content-type'])
  };
}

async function persistInboundMediaFromUrl(mapped, integration, options) {
  options = options || {};
  var startedAt = Date.now();
  var baseFileUrl = getBaseFileUrl(options);
  if (!shouldPersistExternalMedia(mapped, baseFileUrl)) {
    return null;
  }

  var sourceUrl = mapped.metadata.src;
  var integrationId = integration && integration._id ? integration._id.toString() : 'unknown';
  try {
    var downloaded = await downloadExternalMedia(sourceUrl, options);
    var inferredFromMetadata = validMime(mapped.metadata.type);
    var inferredFromName = validMime(mime.lookup(mapped.metadata.name || filenameFromUrl(sourceUrl)));
    var contentType = validMime(downloaded.contentType) || inferredFromMetadata || inferredFromName || 'application/octet-stream';
    var detectedContentType = await detectContentType(downloaded.buffer);

    if (contentType === 'application/octet-stream') {
      contentType = detectedContentType || validMime(mime.lookup(filenameFromUrl(sourceUrl))) || contentType;
    } else if (
      detectedContentType &&
      detectedContentType !== contentType &&
      canTrustDetectedContentType(mapped, detectedContentType)
    ) {
      contentType = detectedContentType;
    }

    var originalname = originalFilename(mapped, sourceUrl, contentType);
    await verifyFileContent(downloaded.buffer, contentType);

    var filename = buildChatFilePath({
      userId: 'casezap-' + integrationId,
      folderName: 'files',
      originalname: originalname
    });
    var expireAt = options.expireAt || new Date(Date.now() + parseInt(process.env.CHAT_FILE_EXPIRATION_TIME || '2592000', 10) * 1000);
    var fileService = options.fileService || getDefaultFileService();

    await waitForFileServiceReady(fileService);
    await fileService.createFile(filename, downloaded.buffer, undefined, contentType, { metadata: { expireAt: expireAt } });

    var thumbnail;
    try {
      thumbnail = await createChatImageThumbnail({
        fileService: fileService,
        filename: filename,
        buffer: downloaded.buffer,
        mimetype: contentType,
        expireAt: expireAt
      });
    } catch (err) {
      winston.warn('CaseZap thumbnail generation failed: ' + err.message);
    }

    operationalLogger.recordSafe({
      area: 'storage',
      channel: 'casezap',
      id_project: integration && integration.id_project,
      integrationId: integrationId,
      messageId: mapped.messageId,
      event: 'media.rehosted',
      status: 'success',
      latencyMs: Date.now() - startedAt,
      details: {
        filename: filename,
        contentType: contentType,
        bytes: downloaded.buffer.length,
        thumbnail: Boolean(thumbnail)
      }
    });

    var projectId = integration && integration.id_project ? String(integration.id_project) : undefined;
    var urls = publicFileUrls(filename, baseFileUrl, projectId, options);
    var thumbnailUrls = thumbnail ? publicFileUrls(thumbnail, baseFileUrl, projectId, options) : {};
    return {
      filename: filename,
      url: urls.url,
      downloadUrl: urls.downloadUrl,
      cdnUrl: urls.cdnUrl,
      downloadCdnUrl: urls.downloadCdnUrl,
      proxyUrl: urls.proxyUrl,
      proxyDownloadUrl: urls.proxyDownloadUrl,
      thumbnail: thumbnail,
      thumbnailUrl: thumbnail ? thumbnailUrls.url : undefined,
      thumbnailCdnUrl: thumbnailUrls.cdnUrl,
      thumbnailDownloadCdnUrl: thumbnailUrls.downloadCdnUrl,
      thumbnailProxyUrl: thumbnailUrls.proxyUrl,
      sourceUrl: sourceUrl,
      contentType: contentType
    };
  } catch (err2) {
    if (isMaxSizeExceededError(err2)) {
      var skipped = externalOnlyMediaResult(
        mapped,
        sourceUrl,
        'max_size_exceeded',
        err2.response && err2.response.headers
      );
      operationalLogger.recordSafe({
        area: 'storage',
        channel: 'casezap',
        id_project: integration && integration.id_project,
        integrationId: integrationId,
        messageId: mapped.messageId,
        event: 'media.rehost_skipped',
        status: 'skipped',
        latencyMs: Date.now() - startedAt,
        details: {
          reason: skipped.rehostReason,
          filename: skipped.filename,
          contentType: skipped.contentType,
          bytes: skipped.size
        }
      });
      return skipped;
    }

    operationalLogger.recordSafe({
      level: 'error',
      area: 'storage',
      channel: 'casezap',
      id_project: integration && integration.id_project,
      integrationId: integrationId,
      messageId: mapped.messageId,
      event: 'media.rehost_failed',
      status: 'failed',
      latencyMs: Date.now() - startedAt,
      error: err2
    });
    throw err2;
  }
}

async function persistMappedMedia(mapped, integration, options) {
  var stored = await persistInboundMediaFromUrl(mapped, integration, options);
  if (!stored) {
    return mapped;
  }

  mapped.metadata.externalSrc = stored.sourceUrl;
  mapped.metadata.src = stored.url;
  mapped.metadata.downloadUrl = stored.downloadUrl;
  if (stored.cdnUrl) {
    mapped.metadata.cdnUrl = stored.cdnUrl;
  }
  if (stored.downloadCdnUrl) {
    mapped.metadata.downloadCdnUrl = stored.downloadCdnUrl;
  }
  if (stored.proxyUrl) {
    mapped.metadata.proxySrc = stored.proxyUrl;
  }
  if (stored.proxyDownloadUrl) {
    mapped.metadata.proxyDownloadUrl = stored.proxyDownloadUrl;
  }
  if (stored.externalOnly) {
    mapped.metadata.externalOnly = true;
    mapped.metadata.rehostSkipped = true;
    mapped.metadata.rehostReason = stored.rehostReason;
  }
  if (stored.size) {
    mapped.metadata.size = stored.size;
  }
  if (stored.thumbnailUrl) {
    mapped.metadata.thumbnail = stored.thumbnailUrl;
  }
  if (stored.thumbnailCdnUrl) {
    mapped.metadata.thumbnailCdnUrl = stored.thumbnailCdnUrl;
  }
  if (stored.contentType && mapped.type !== 'image') {
    mapped.metadata.type = stored.contentType;
  }
  mapped.text = refreshAudioMarker(mapped.text, mapped.metadata);
  if (mapped.type === 'file' && mapped.metadata.name) {
    var href = stored.externalOnly ? (stored.downloadUrl || stored.url) : stored.url;
    mapped.text = '[' + mapped.metadata.name + '](' + href + ')';
  }

  return mapped;
}

module.exports = {
  downloadExternalMedia: downloadExternalMedia,
  getBaseFileUrl: getBaseFileUrl,
  isLocalFileUrl: isLocalFileUrl,
  persistInboundMediaFromUrl: persistInboundMediaFromUrl,
  persistMappedMedia: persistMappedMedia,
  shouldPersistExternalMedia: shouldPersistExternalMedia
};
