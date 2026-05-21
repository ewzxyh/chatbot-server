const crypto = require('crypto');

function trimSlashes(value) {
  return String(value || '').replace(/^\/+|\/+$/g, '');
}

function normalizeMediaPath(filename) {
  const decoded = safeDecode(String(filename || '').replace(/\\/g, '/')).trim();
  const normalized = trimSlashes(decoded);

  if (!normalized || normalized.startsWith('.') || normalized.includes('..') || normalized.includes('\0')) {
    throw new Error('Unsafe media path');
  }

  if (normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Unsafe media path');
  }

  return normalized;
}

function safeDecode(value) {
  let decoded = value;
  for (let i = 0; i < 3; i += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        return decoded;
      }
      decoded = next;
    } catch (err) {
      return decoded;
    }
  }
  return decoded;
}

function encodePath(path) {
  return normalizeMediaPath(path)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function isEnabled(env) {
  env = env || process.env;
  return env.MEDIA_CDN_ENABLED === 'true' &&
    Boolean(env.MEDIA_CDN_BASE_URL) &&
    Boolean(env.MEDIA_CDN_SIGNING_SECRET);
}

function replaceSrcEnabled(env) {
  env = env || process.env;
  return env.MEDIA_CDN_REPLACE_SRC === 'true';
}

function ttlSeconds(env) {
  env = env || process.env;
  const parsed = parseInt(env.MEDIA_CDN_DEFAULT_TTL_SECONDS || env.MEDIA_CDN_TTL_SECONDS || '604800', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 604800;
}

function expiresAtSeconds(options) {
  options = options || {};
  const now = options.now instanceof Date ? options.now : new Date();
  return Math.floor(now.getTime() / 1000) + ttlSeconds(options.env);
}

function sign(pathname, exp, disposition, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(['GET', pathname, String(exp), disposition || 'inline'].join('\n'))
    .digest('base64url');
}

function buildProxyUrls(filename, baseFileUrl, projectId) {
  const encodedPath = encodeURIComponent(normalizeMediaPath(filename));
  const projectQuery = projectId ? '&id_project=' + encodeURIComponent(projectId) : '';
  const base = String(baseFileUrl || '').replace(/\/+$/, '');
  return {
    url: base + '/files?path=' + encodedPath + projectQuery,
    downloadUrl: base + '/files/download?path=' + encodedPath + projectQuery
  };
}

function buildSignedMediaUrl(filename, options) {
  options = options || {};
  const env = options.env || process.env;
  if (!isEnabled(env)) {
    return undefined;
  }

  const baseUrl = String(env.MEDIA_CDN_BASE_URL || '').replace(/\/+$/, '');
  const disposition = options.disposition === 'attachment' ? 'attachment' : 'inline';
  const pathname = '/files/' + encodePath(filename);
  const exp = options.exp || expiresAtSeconds(options);
  const sig = sign(pathname, exp, disposition, env.MEDIA_CDN_SIGNING_SECRET);
  const url = new URL(baseUrl + pathname);
  url.searchParams.set('exp', String(exp));
  url.searchParams.set('disposition', disposition);
  url.searchParams.set('sig', sig);
  return url.toString();
}

function buildMediaUrls(options) {
  options = options || {};
  const proxy = buildProxyUrls(options.filename, options.baseFileUrl, options.projectId);
  const cdnUrl = buildSignedMediaUrl(options.filename, {
    env: options.env,
    now: options.now,
    exp: options.exp,
    disposition: 'inline'
  });
  const downloadCdnUrl = buildSignedMediaUrl(options.filename, {
    env: options.env,
    now: options.now,
    exp: options.exp,
    disposition: 'attachment'
  });
  const preferCdnUrl = options.preferCdnUrl !== false;

  if (!cdnUrl || !downloadCdnUrl) {
    return {
      url: proxy.url,
      downloadUrl: proxy.downloadUrl,
      cdnEnabled: false
    };
  }

  return {
    url: preferCdnUrl ? cdnUrl : proxy.url,
    downloadUrl: preferCdnUrl ? downloadCdnUrl : proxy.downloadUrl,
    cdnUrl,
    downloadCdnUrl,
    proxyUrl: proxy.url,
    proxyDownloadUrl: proxy.downloadUrl,
    cdnEnabled: true
  };
}

module.exports = {
  buildMediaUrls,
  buildProxyUrls,
  buildSignedMediaUrl,
  encodePath,
  isEnabled,
  normalizeMediaPath,
  replaceSrcEnabled,
  sign,
  ttlSeconds
};
