process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

const assert = require('assert');
const crypto = require('crypto');

const mediaCdnUrlService = require('../services/mediaCdnUrlService');

function testEnv(overrides) {
  return Object.assign({
    MEDIA_CDN_ENABLED: 'true',
    MEDIA_CDN_BASE_URL: 'https://media.example.com',
    MEDIA_CDN_SIGNING_SECRET: 'REDACTED_SECRET',
    MEDIA_CDN_DEFAULT_TTL_SECONDS: '60'
  }, overrides || {});
}

function expectedSignature(pathname, exp, disposition) {
  return crypto
    .createHmac('sha256', 'test-secret-with-enough-entropy')
    .update(['GET', pathname, String(exp), disposition || 'inline'].join('\n'))
    .digest('base64url');
}

describe('mediaCdnUrlService', function() {
  it('builds deterministic signed inline URLs for R2 media paths', function() {
    const now = new Date('2026-05-20T00:00:00.000Z');
    const url = mediaCdnUrlService.buildSignedMediaUrl(
      'uploads/users/u1/files/photo.jpg',
      { env: testEnv(), now: now, disposition: 'inline' }
    );

    const parsed = new URL(url);
    const exp = Math.floor(now.getTime() / 1000) + 60;

    assert.strictEqual(parsed.origin, 'https://media.example.com');
    assert.strictEqual(parsed.pathname, '/files/uploads/users/u1/files/photo.jpg');
    assert.strictEqual(parsed.searchParams.get('exp'), String(exp));
    assert.strictEqual(parsed.searchParams.get('disposition'), 'inline');
    assert.strictEqual(parsed.searchParams.get('sig'), expectedSignature(parsed.pathname, exp, 'inline'));
  });

  it('creates separate inline and attachment URLs while preserving API proxy fallback URLs', function() {
    const urls = mediaCdnUrlService.buildMediaUrls({
      filename: 'uploads/users/u1/files/report.pdf',
      baseFileUrl: 'https://app.example/api',
      projectId: 'project-1',
      env: testEnv(),
      now: new Date('2026-05-20T00:00:00.000Z')
    });

    assert.ok(urls.url.startsWith('https://media.example.com/files/uploads/users/u1/files/report.pdf?'));
    assert.ok(urls.downloadUrl.startsWith('https://media.example.com/files/uploads/users/u1/files/report.pdf?'));
    assert.strictEqual(new URL(urls.url).searchParams.get('disposition'), 'inline');
    assert.strictEqual(new URL(urls.downloadUrl).searchParams.get('disposition'), 'attachment');
    assert.strictEqual(
      urls.proxyUrl,
      'https://app.example/api/files?path=uploads%2Fusers%2Fu1%2Ffiles%2Freport.pdf&id_project=project-1'
    );
    assert.strictEqual(
      urls.proxyDownloadUrl,
      'https://app.example/api/files/download?path=uploads%2Fusers%2Fu1%2Ffiles%2Freport.pdf&id_project=project-1'
    );
  });

  it('falls back to API proxy URLs when CDN signing is disabled or incomplete', function() {
    const urls = mediaCdnUrlService.buildMediaUrls({
      filename: 'uploads/users/u1/files/report.pdf',
      baseFileUrl: 'https://app.example/api',
      projectId: 'project-1',
      env: { MEDIA_CDN_ENABLED: 'false' }
    });

    assert.strictEqual(
      urls.url,
      'https://app.example/api/files?path=uploads%2Fusers%2Fu1%2Ffiles%2Freport.pdf&id_project=project-1'
    );
    assert.strictEqual(urls.proxyUrl, undefined);
    assert.strictEqual(urls.cdnEnabled, false);
  });

  it('rejects unsafe media paths before signing', function() {
    assert.throws(function() {
      mediaCdnUrlService.buildSignedMediaUrl('../secret.txt', { env: testEnv() });
    }, /Unsafe media path/);
  });
});
