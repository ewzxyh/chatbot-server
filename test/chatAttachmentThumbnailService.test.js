process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const { createChatImageThumbnail } = require('../services/chatAttachmentThumbnailService');

describe('chatAttachmentThumbnailService', () => {
  it('creates a thumbnail beside chat image uploads', async () => {
    const source = fs.readFileSync(path.join(__dirname, 'fixtures', 'test-image.png'));
    const createdFiles = [];
    const expireAt = new Date('2026-05-08T12:00:00.000Z');
    const fileService = {
      async createFile(filename, buffer, _metadata, contentType, options) {
        createdFiles.push({ filename, buffer, contentType, options });
      },
      async find(filename) {
        return { _id: 'thumb-file-id', filename };
      },
    };
    const expirations = [];

    const thumbnail = await createChatImageThumbnail({
      fileService,
      filename: 'uploads/users/user-1/files/folder-1/photo.png',
      buffer: source,
      mimetype: 'image/png',
      expireAt,
      setExpiration: async (file, expiresAt) => {
        expirations.push({ file, expiresAt });
      },
    });

    expect(thumbnail).to.equal('uploads/users/user-1/files/folder-1/thumbnails_200_200-photo.png');
    expect(createdFiles).to.have.length(1);
    expect(createdFiles[0].filename).to.equal(thumbnail);
    expect(createdFiles[0].buffer).to.be.instanceOf(Buffer);
    expect(createdFiles[0].buffer.length).to.be.greaterThan(0);
    expect(createdFiles[0].contentType).to.equal('image/png');
    expect(createdFiles[0].options).to.deep.equal({ metadata: { expireAt } });
    expect(expirations).to.deep.equal([
      { file: { _id: 'thumb-file-id', filename: thumbnail }, expiresAt: expireAt },
    ]);
  });

  it('does not create thumbnails for non-image chat uploads', async () => {
    const fileService = {
      async createFile() {
        throw new Error('createFile should not be called');
      },
    };

    const thumbnail = await createChatImageThumbnail({
      fileService,
      filename: 'uploads/users/user-1/files/folder-1/manual.pdf',
      buffer: Buffer.from('%PDF'),
      mimetype: 'application/pdf',
    });

    expect(thumbnail).to.equal(undefined);
  });
});
