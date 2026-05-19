process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

const assert = require('assert');
const filesRoute = require('../routes/filesp');

describe('file upload policy', function() {
  it('skips content verification for chat uploads when every extension is allowed', function() {
    const req = {
      project: { settings: { allowed_upload_extentions: '*/*' } },
      projectuser: { role: 'admin', roleType: 1 }
    };

    assert.strictEqual(filesRoute.__test.shouldVerifyUploadedContent(req, 'chat'), false);
  });

  it('keeps avatar uploads content-verified even when chat uploads allow everything', function() {
    const req = {
      project: { settings: { allowed_upload_extentions: '*/*' } },
      projectuser: { role: 'admin', roleType: 1 }
    };

    assert.strictEqual(filesRoute.__test.shouldVerifyUploadedContent(req, 'avatar'), true);
  });
});
