process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

const { expect } = require('chai');

const {
  buildAvatarPath,
  buildChatFilePath,
  buildProjectAssetPath,
  buildThumbnailPath,
} = require('../services/fileUploadPathBuilder');

describe('fileUploadPathBuilder', () => {
  it('builds chat upload paths under the authenticated user', () => {
    const path = buildChatFilePath({
      userId: 'user-1',
      folderName: 'files',
      folder: 'folder-1',
      originalname: 'manual.pdf',
    });

    expect(path).to.equal('uploads/users/user-1/files/folder-1/manual.pdf');
  });

  it('normalizes client supplied path separators from filenames', () => {
    const path = buildChatFilePath({
      userId: 'user-1',
      folderName: 'files',
      folder: 'folder-1',
      originalname: '..\\nested\\manual.pdf',
    });

    expect(path).to.equal('uploads/users/user-1/files/folder-1/manual.pdf');
  });

  it('builds public chat upload paths when there is no user', () => {
    const path = buildChatFilePath({
      folderName: 'files',
      folder: 'folder-1',
      originalname: 'manual.pdf',
    });

    expect(path).to.equal('uploads/public/files/folder-1/manual.pdf');
  });

  it('builds project asset paths under the project id', () => {
    const path = buildProjectAssetPath({
      projectId: 'project-1',
      folderName: 'files',
      folder: 'asset-1',
      originalname: 'logo.png',
    });

    expect(path).to.equal('uploads/projects/project-1/files/asset-1/logo.png');
  });

  it('builds fixed avatar paths that stay compatible with existing clients', () => {
    expect(buildAvatarPath({ entityId: 'bot-1' })).to.equal('uploads/users/bot-1/images/photo.jpg');
  });

  it('builds thumbnail paths beside the original file', () => {
    const thumbnail = buildThumbnailPath('uploads/users/user-1/images/photo.jpg');

    expect(thumbnail).to.equal('uploads/users/user-1/images/thumbnails_200_200-photo.jpg');
  });
});
