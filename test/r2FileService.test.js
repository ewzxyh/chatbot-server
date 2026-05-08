process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

const { expect } = require('chai');
const nock = require('nock');
const { Readable } = require('stream');

const R2FileService = require('../services/r2FileService');

class FakeS3Client {
  constructor(responses = []) {
    this.responses = responses;
    this.commands = [];
  }

  async send(command) {
    this.commands.push(command);
    const response = this.responses.shift();
    if (response instanceof Error) {
      throw response;
    }
    return response || {};
  }
}

describe('R2FileService', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it('stores files in the configured bucket using a normalized prefixed key', async () => {
    const client = new FakeS3Client();
    const service = new R2FileService('files', {
      bucket: 'chatcase-uploads',
      client,
      keyPrefix: '/prod/uploads/',
    });

    await service.createFile(
      '/uploads/users/user-1/files/file-1/photo.png',
      Buffer.from('image'),
      undefined,
      'image/png',
      { metadata: { expireAt: new Date('2026-05-07T12:00:00.000Z'), ignored: undefined } }
    );

    expect(client.commands).to.have.length(1);
    expect(client.commands[0].constructor.name).to.equal('PutObjectCommand');
    expect(client.commands[0].input).to.include({
      Bucket: 'chatcase-uploads',
      Key: 'prod/uploads/uploads/users/user-1/files/file-1/photo.png',
      ContentType: 'image/png',
    });
    expect(client.commands[0].input.Metadata).to.deep.equal({
      expireAt: '2026-05-07T12:00:00.000Z',
    });
  });

  it('maps object metadata to the GridFS-compatible find shape', async () => {
    const client = new FakeS3Client([
      {
        ContentLength: 42,
        ContentType: 'application/pdf',
        Metadata: { expireAt: '2026-05-07T12:00:00.000Z' },
      },
    ]);
    const service = new R2FileService('files', {
      bucket: 'chatcase-uploads',
      client,
      keyPrefix: 'prod',
    });

    const file = await service.find('uploads/users/user-1/files/file-1/manual.pdf');

    expect(client.commands[0].constructor.name).to.equal('HeadObjectCommand');
    expect(client.commands[0].input.Key).to.equal('prod/uploads/users/user-1/files/file-1/manual.pdf');
    expect(file).to.deep.include({
      filename: 'uploads/users/user-1/files/file-1/manual.pdf',
      length: 42,
      contentType: 'application/pdf',
    });
    expect(file.metadata).to.deep.equal({ expireAt: '2026-05-07T12:00:00.000Z' });
  });

  it('reads object bodies as buffers', async () => {
    const client = new FakeS3Client([
      {
        Body: Readable.from([Buffer.from('hello '), Buffer.from('world')]),
      },
    ]);
    const service = new R2FileService('files', {
      bucket: 'chatcase-uploads',
      client,
    });

    const buffer = await service.getFileDataAsBuffer('uploads/users/user-1/files/file-1/readme.txt');

    expect(client.commands[0].constructor.name).to.equal('GetObjectCommand');
    expect(buffer.toString()).to.equal('hello world');
  });

  it('deletes objects by key and returns the original filename', async () => {
    const client = new FakeS3Client();
    const service = new R2FileService('files', {
      bucket: 'chatcase-uploads',
      client,
      keyPrefix: 'prod',
    });

    const result = await service.deleteFile('/uploads/users/user-1/files/file-1/photo.png');

    expect(client.commands[0].constructor.name).to.equal('DeleteObjectCommand');
    expect(client.commands[0].input).to.include({
      Bucket: 'chatcase-uploads',
      Key: 'prod/uploads/users/user-1/files/file-1/photo.png',
    });
    expect(result).to.deep.equal({ filename: 'uploads/users/user-1/files/file-1/photo.png' });
  });

  it('sends signed path-style requests to the R2 account endpoint', async () => {
    const scope = nock('https://account-id.r2.cloudflarestorage.com', {
      reqheaders: {
        authorization: /AWS4-HMAC-SHA256 Credential=access-key\/\d{8}\/auto\/s3\/aws4_request/,
        'x-amz-content-sha256': /^[a-f0-9]{64}$/,
        'x-amz-date': /^\d{8}T\d{6}Z$/,
      },
    })
      .put('/chatcase-uploads/prod/uploads/users/user-1/files/file-1/photo.png', 'image')
      .reply(200);

    const service = new R2FileService('files', {
      accountId: 'account-id',
      accessKeyId: 'access-key',
      bucket: 'chatcase-uploads',
      keyPrefix: 'prod',
      secretAccessKey: 'secret-key',
    });

    await service.createFile(
      'uploads/users/user-1/files/file-1/photo.png',
      Buffer.from('image'),
      undefined,
      'image/png'
    );

    scope.done();
  });
});
