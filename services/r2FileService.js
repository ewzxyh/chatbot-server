const crypto = require('crypto');
const https = require('https');
const { PassThrough, Readable } = require('stream');

const FileService = require('./fileService');

class PutObjectCommand {
  constructor(input) {
    this.input = input;
  }
}

class GetObjectCommand {
  constructor(input) {
    this.input = input;
  }
}

class HeadObjectCommand {
  constructor(input) {
    this.input = input;
  }
}

class DeleteObjectCommand {
  constructor(input) {
    this.input = input;
  }
}

function trimSlashes(value) {
  return String(value || '').replace(/^\/+|\/+$/g, '');
}

function normalizeFilename(filename) {
  return trimSlashes(String(filename || '').replace(/\\/g, '/'));
}

function normalizeMetadata(metadata) {
  if (!metadata) {
    return undefined;
  }

  return Object.keys(metadata).reduce((result, key) => {
    const value = metadata[key];
    if (value === undefined || value === null) {
      return result;
    }
    result[key] = value instanceof Date ? value.toISOString() : String(value);
    return result;
  }, {});
}

function notFoundError(filename) {
  return { code: 'ENOENT', msg: 'File not found', filename };
}

function isNotFoundError(error) {
  return error?.code === 'ENOENT'
    || error?.code === 'NotFound'
    || error?.code === 'NoSuchKey'
    || error?.name === 'NotFound'
    || error?.name === 'NoSuchKey'
    || error?.$metadata?.httpStatusCode === 404
    || error?.statusCode === 404;
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data || '').digest('hex');
}

function hmac(key, data, encoding) {
  return crypto.createHmac('sha256', key).update(data).digest(encoding);
}

function toBuffer(body) {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body === undefined || body === null) {
    return Buffer.alloc(0);
  }
  if (typeof body === 'string') {
    return Buffer.from(body);
  }
  throw new Error('R2FileService only supports Buffer or string request bodies');
}

function encodeKey(key) {
  return normalizeFilename(key)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function collectStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('error', reject);
    stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function metadataFromHeaders(headers) {
  return Object.keys(headers).reduce((metadata, header) => {
    if (header.startsWith('x-amz-meta-')) {
      metadata[header.slice('x-amz-meta-'.length)] = headers[header];
    }
    return metadata;
  }, {});
}

class R2HttpClient {
  constructor(options) {
    this.endpoint = options.endpoint;
    this.region = options.region || 'auto';
    this.accessKeyId = options.accessKeyId;
    this.secretAccessKey = options.secretAccessKey;
  }

  async send(command) {
    const input = command.input;
    const method = command instanceof PutObjectCommand
      ? 'PUT'
      : command instanceof GetObjectCommand
        ? 'GET'
        : command instanceof HeadObjectCommand
          ? 'HEAD'
          : 'DELETE';

    const body = method === 'PUT' ? toBuffer(input.Body) : Buffer.alloc(0);
    const response = await this.request(method, input.Bucket, input.Key, body, input.ContentType, input.Metadata, input.Range);

    if (command instanceof HeadObjectCommand) {
      return {
        ContentLength: Number(response.headers['content-length'] || 0),
        ContentType: response.headers['content-type'],
        Metadata: metadataFromHeaders(response.headers),
      };
    }

    if (command instanceof GetObjectCommand) {
      return { Body: response.body };
    }

    return {};
  }

  request(method, bucket, key, body, contentType, metadata, rangeHeader) {
    const endpoint = new URL(this.endpoint);
    const encodedKey = encodeKey(key);
    const pathname = `/${encodeURIComponent(bucket)}/${encodedKey}`;
    const requestUrl = new URL(endpoint.toString());
    requestUrl.pathname = `${trimSlashes(endpoint.pathname) ? `/${trimSlashes(endpoint.pathname)}` : ''}${pathname}`;

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(body);
    const headers = {
      host: requestUrl.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };

    if (method === 'PUT') {
      headers['content-length'] = String(body.length);
    }

    if (contentType) {
      headers['content-type'] = contentType;
    }

    if (method === 'GET' && rangeHeader) {
      headers.range = rangeHeader;
    }

    Object.keys(metadata || {}).forEach((key) => {
      headers[`x-amz-meta-${key.toLowerCase()}`] = String(metadata[key]);
    });

    headers.authorization = this.authorizationHeader(method, requestUrl.pathname, headers, payloadHash, amzDate, dateStamp);

    const requestOptions = {
      method,
      protocol: requestUrl.protocol,
      hostname: requestUrl.hostname,
      port: requestUrl.port,
      path: requestUrl.pathname,
      headers,
    };

    return new Promise((resolve, reject) => {
      const req = https.request(requestOptions, (res) => {
        res.on('error', reject);

        if (res.statusCode >= 300) {
          collectStream(res).then((errorBody) => {
            const error = new Error(`R2 request failed with status ${res.statusCode}: ${errorBody.toString()}`);
            error.statusCode = res.statusCode;
            error.$metadata = { httpStatusCode: res.statusCode };
            if (res.statusCode === 404) {
              error.code = 'ENOENT';
            }
            reject(error);
          }).catch(reject);
          return;
        }

        if (method === 'GET') {
          resolve({ headers: res.headers, body: res });
          return;
        }

        res.resume();
        res.on('end', () => resolve({ headers: res.headers, body: undefined }));
      });

      req.on('error', reject);

      if (method === 'PUT') {
        req.write(body);
      }
      req.end();
    });
  }

  authorizationHeader(method, canonicalUri, headers, payloadHash, amzDate, dateStamp) {
    const signedHeaderNames = Object.keys(headers).map((name) => name.toLowerCase()).sort();
    const canonicalHeaders = signedHeaderNames
      .map((name) => `${name}:${String(headers[name]).trim().replace(/\s+/g, ' ')}\n`)
      .join('');
    const signedHeaders = signedHeaderNames.join(';');
    const canonicalRequest = [
      method,
      canonicalUri,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const kDate = hmac(`AWS4${this.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, this.region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = hmac(kSigning, stringToSign, 'hex');

    return `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  }
}

class R2FileService extends FileService {
  constructor(bucketName, options = {}) {
    super();
    this.provider = 'r2';
    this.storageType = 'r2';
    this.bucketName = bucketName;
    this.bucket = options.bucket || process.env.R2_BUCKET || process.env.CLOUDFLARE_R2_BUCKET;
    this.keyPrefix = trimSlashes(options.keyPrefix || process.env.R2_KEY_PREFIX || process.env.CLOUDFLARE_R2_KEY_PREFIX);
    this.region = options.region || process.env.R2_REGION || process.env.CLOUDFLARE_R2_REGION || 'auto';
    this.endpoint = options.endpoint
      || process.env.R2_ENDPOINT
      || process.env.CLOUDFLARE_R2_ENDPOINT
      || this.endpointFromAccountId(options.accountId || process.env.R2_ACCOUNT_ID || process.env.CLOUDFLARE_R2_ACCOUNT_ID);

    this.client = options.client || new R2HttpClient({
      endpoint: this.endpoint,
      region: this.region,
      accessKeyId: options.accessKeyId || process.env.R2_ACCESS_KEY_ID || process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
      secretAccessKey: options.secretAccessKey || process.env.R2_SECRET_ACCESS_KEY || process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
    });

    if (!options.client) {
      this.validateConfiguration(options);
    }
  }

  static isEnabled(env = process.env) {
    const provider = env.FILE_STORAGE_DRIVER || env.FILE_STORAGE_PROVIDER || env.STORAGE_DRIVER;
    return ['r2', 'cloudflare-r2', 'cloudflare'].includes(String(provider || '').toLowerCase())
      || env.R2_ENABLED === 'true'
      || env.CLOUDFLARE_R2_ENABLED === 'true';
  }

  static isConfigured(env = process.env) {
    const endpoint = env.R2_ENDPOINT
      || env.CLOUDFLARE_R2_ENDPOINT
      || (env.R2_ACCOUNT_ID || env.CLOUDFLARE_R2_ACCOUNT_ID);
    const bucket = env.R2_BUCKET || env.CLOUDFLARE_R2_BUCKET;
    const accessKey = env.R2_ACCESS_KEY_ID || env.CLOUDFLARE_R2_ACCESS_KEY_ID;
    const secretKey = env.R2_SECRET_ACCESS_KEY || env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
    return R2FileService.isEnabled(env) && Boolean(endpoint && bucket && accessKey && secretKey);
  }

  endpointFromAccountId(accountId) {
    return accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined;
  }

  validateConfiguration(options) {
    const missing = [];
    if (!this.endpoint) missing.push('R2_ENDPOINT or R2_ACCOUNT_ID');
    if (!this.bucket) missing.push('R2_BUCKET');
    if (!(options.accessKeyId || process.env.R2_ACCESS_KEY_ID || process.env.CLOUDFLARE_R2_ACCESS_KEY_ID)) missing.push('R2_ACCESS_KEY_ID');
    if (!(options.secretAccessKey || process.env.R2_SECRET_ACCESS_KEY || process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY)) missing.push('R2_SECRET_ACCESS_KEY');

    if (missing.length > 0) {
      throw new Error(`Cloudflare R2 storage is enabled but missing: ${missing.join(', ')}`);
    }
  }

  keyFor(filename) {
    const normalizedFilename = normalizeFilename(filename);
    return this.keyPrefix ? `${this.keyPrefix}/${normalizedFilename}` : normalizedFilename;
  }

  async createFile(filename, data, path, contentType, options) {
    const normalizedFilename = normalizeFilename(filename);
    const metadata = normalizeMetadata(options && options.metadata);

    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.keyFor(normalizedFilename),
      Body: data,
      ContentType: contentType,
      Metadata: metadata,
    }));

    return {
      filename: normalizedFilename,
      length: Buffer.isBuffer(data) ? data.length : undefined,
      contentType,
      metadata,
    };
  }

  async find(filename) {
    const normalizedFilename = normalizeFilename(filename);
    try {
      const result = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: this.keyFor(normalizedFilename),
      }));

      return {
        filename: normalizedFilename,
        length: Number(result.ContentLength || 0),
        contentType: result.ContentType,
        metadata: result.Metadata || {},
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        throw notFoundError(normalizedFilename);
      }
      throw error;
    }
  }

  async deleteFile(filename) {
    const normalizedFilename = normalizeFilename(filename);
    try {
      await this.client.send(new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: this.keyFor(normalizedFilename),
      }));
      return { filename: normalizedFilename };
    } catch (error) {
      if (isNotFoundError(error)) {
        throw notFoundError(normalizedFilename);
      }
      throw error;
    }
  }

  getFileDataAsStream(filename, options) {
    const stream = new PassThrough();
    const normalizedFilename = normalizeFilename(filename);
    const input = {
      Bucket: this.bucket,
      Key: this.keyFor(normalizedFilename),
    };

    if (options && options.start !== undefined && options.end !== undefined) {
      input.Range = `bytes=${options.start}-${options.end - 1}`;
    }

    this.client.send(new GetObjectCommand(input)).then((result) => {
      const body = result.Body;
      if (body instanceof Readable || typeof body.pipe === 'function') {
        body.on('error', (error) => stream.emit('error', error));
        body.pipe(stream);
      } else {
        stream.end(body || Buffer.alloc(0));
      }
    }).catch((error) => {
      if (isNotFoundError(error)) {
        stream.emit('error', notFoundError(normalizedFilename));
      } else {
        stream.emit('error', error);
      }
    });

    return stream;
  }

  async getFileDataAsBuffer(filename) {
    const normalizedFilename = normalizeFilename(filename);
    try {
      const result = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.keyFor(normalizedFilename),
      }));

      if (Buffer.isBuffer(result.Body)) {
        return result.Body;
      }
      if (typeof result.Body === 'string') {
        return Buffer.from(result.Body);
      }
      return collectStream(result.Body);
    } catch (error) {
      if (isNotFoundError(error)) {
        throw notFoundError(normalizedFilename);
      }
      throw error;
    }
  }
}

module.exports = R2FileService;
