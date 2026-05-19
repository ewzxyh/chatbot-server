process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

const assert = require('assert');
const nock = require('nock');

const {
  persistMappedMedia,
  shouldPersistExternalMedia
} = require('../../pubmodules/casezap/mediaStorage');

describe('CaseZap mediaStorage', function() {
  afterEach(function() {
    nock.cleanAll();
  });

  it('rehosts external UazApi documents through the ChatCase file endpoint', async function() {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
    const sourceUrl = 'https://chatcase.uazapi.com/files/remote.pdf';
    const stored = [];
    const fileService = {
      createFile: async function(filename, buffer, path, contentType, options) {
        stored.push({ filename, buffer, contentType, options });
      }
    };

    nock('https://chatcase.uazapi.com')
      .get('/files/remote.pdf')
      .reply(200, pdf, { 'Content-Type': 'application/pdf' });

    const mapped = {
      messageId: 'doc-1',
      type: 'file',
      text: '[remote.pdf](' + sourceUrl + ')',
      metadata: {
        src: sourceUrl,
        name: 'remote.pdf',
        type: 'application/pdf'
      }
    };

    const result = await persistMappedMedia(mapped, { _id: '69f1115ecbfe61136b1535ea' }, {
      fileService,
      baseFileUrl: 'https://app.example/api',
      expireAt: new Date('2026-05-08T00:00:00Z')
    });

    assert.strictEqual(stored.length, 1);
    assert.ok(stored[0].filename.startsWith('uploads/users/casezap-69f1115ecbfe61136b1535ea/files/'));
    assert.ok(stored[0].filename.endsWith('/remote.pdf'));
    assert.strictEqual(stored[0].contentType, 'application/pdf');
    assert.strictEqual(result.metadata.externalSrc, sourceUrl);
    assert.ok(result.metadata.src.startsWith('https://app.example/api/files?path='));
    assert.ok(result.metadata.downloadUrl.startsWith('https://app.example/api/files/download?path='));
    assert.strictEqual(result.text, '[' + result.metadata.name + '](' + result.metadata.src + ')');
  });

  it('does not rehost media that already points to the local ChatCase file endpoint', async function() {
    const mapped = {
      type: 'file',
      metadata: {
        src: 'https://app.example/api/files?path=uploads%2Fusers%2Fx%2Ffiles%2Fy%2Fdoc.pdf'
      }
    };

    assert.strictEqual(shouldPersistExternalMedia(mapped, 'https://app.example/api'), false);
  });

  it('keeps an external attachment link when the CaseZap file is too large to rehost', async function() {
    const sourceUrl = 'https://chatcase.uazapi.com/files/Antigravity.exe';
    const mapped = {
      messageId: 'large-doc-1',
      type: 'file',
      text: '[Antigravity.exe](' + sourceUrl + ')',
      metadata: {
        src: sourceUrl,
        name: 'Antigravity.exe',
        type: 'application/x-msdownload'
      }
    };
    const httpClient = {
      get: async function() {
        const err = new Error('maxContentLength size of 26214400 exceeded');
        err.code = 'ERR_BAD_RESPONSE';
        err.response = {
          headers: {
            'content-length': '143764912',
            'content-type': 'application/x-msdownload'
          }
        };
        throw err;
      }
    };

    const result = await persistMappedMedia(mapped, { _id: '69f1115ecbfe61136b1535ea' }, {
      httpClient,
      baseFileUrl: 'https://app.example/api'
    });

    assert.strictEqual(result.metadata.src, sourceUrl);
    assert.strictEqual(result.metadata.downloadUrl, sourceUrl);
    assert.strictEqual(result.metadata.externalSrc, sourceUrl);
    assert.strictEqual(result.metadata.externalOnly, true);
    assert.strictEqual(result.metadata.rehostSkipped, true);
    assert.strictEqual(result.metadata.rehostReason, 'max_size_exceeded');
    assert.strictEqual(result.metadata.size, 143764912);
    assert.strictEqual(result.text, '[Antigravity.exe](' + sourceUrl + ')');
  });
});
