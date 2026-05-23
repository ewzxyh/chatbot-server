process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

const assert = require('assert');
const filesRoute = require('../routes/filesp');
const rootFilesRoute = require('../routes/files');

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

  it('recognizes missing native profile-photo paths as placeholder-safe', function() {
    assert.strictEqual(
      filesRoute.__test.isNativeProfilePhotoPath('uploads/users/user-1/images/thumbnails_200_200-photo.jpg'),
      true
    );
    assert.strictEqual(
      rootFilesRoute.__test.isNativeProfilePhotoPath('uploads/users/user-1/images/photo.jpg'),
      true
    );
    assert.strictEqual(
      filesRoute.__test.isNativeProfilePhotoPath('uploads/users/user-1/files/photo.jpg'),
      false
    );
  });
});
