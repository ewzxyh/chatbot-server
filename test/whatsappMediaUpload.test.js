process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nock = require('nock');

const { TiledeskWhatsapp } = require('../pubmodules/whatsapp/connector/tiledesk/TiledeskWhatsapp');

describe('TiledeskWhatsapp uploadMedia', function() {
  afterEach(function() {
    nock.cleanAll();
  });

  it('uploads through API_URL but returns a public BASE_FILE_URL download link', async function() {
    const tmpFile = path.join(os.tmpdir(), 'wab-upload-test.txt');
    fs.writeFileSync(tmpFile, 'hello');

    try {
      const scope = nock('http://internal.example')
        .post('/api/project-1/files/chat')
        .reply(200, { filename: 'uploads/users/report.pdf' });

      const client = new TiledeskWhatsapp({
        token: 'wa-token',
        GRAPH_URL: 'https://graph.example/',
        API_URL: 'http://internal.example/api',
        BASE_FILE_URL: 'https://public.example/api/'
      });

      const uploadedFile = await client.uploadMedia(tmpFile, 'project-1', 'JWT user-token');

      assert.strictEqual(scope.isDone(), true);
      assert.deepStrictEqual(uploadedFile, {
        filename: 'uploads/users/report.pdf',
        url: 'https://public.example/api/files?path=uploads%2Fusers%2Freport.pdf&id_project=project-1',
        downloadUrl: 'https://public.example/api/files/download?path=uploads%2Fusers%2Freport.pdf&id_project=project-1',
      });
    } finally {
      if (fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
    }
  });

  it('returns a public thumbnail download link when the chat upload creates one', async function() {
    const tmpFile = path.join(os.tmpdir(), 'wab-upload-thumbnail-test.jpg');
    fs.writeFileSync(tmpFile, 'image');

    try {
      const scope = nock('http://internal.example')
        .post('/api/project-1/files/chat')
        .reply(201, {
          filename: 'uploads/users/user-1/files/folder-1/photo.jpg',
          thumbnail: 'uploads/users/user-1/files/folder-1/thumbnails_200_200-photo.jpg',
        });

      const client = new TiledeskWhatsapp({
        token: 'wa-token',
        GRAPH_URL: 'https://graph.example/',
        API_URL: 'http://internal.example/api',
        BASE_FILE_URL: 'https://public.example/api/'
      });

      const uploadedFile = await client.uploadMedia(tmpFile, 'project-1', 'JWT user-token');

      assert.strictEqual(scope.isDone(), true);
      assert.deepStrictEqual(uploadedFile, {
        filename: 'uploads/users/user-1/files/folder-1/photo.jpg',
        url: 'https://public.example/api/files?path=uploads%2Fusers%2Fuser-1%2Ffiles%2Ffolder-1%2Fphoto.jpg&id_project=project-1',
        downloadUrl: 'https://public.example/api/files/download?path=uploads%2Fusers%2Fuser-1%2Ffiles%2Ffolder-1%2Fphoto.jpg&id_project=project-1',
        thumbnail: 'uploads/users/user-1/files/folder-1/thumbnails_200_200-photo.jpg',
        thumbnailUrl: 'https://public.example/api/files?path=uploads%2Fusers%2Fuser-1%2Ffiles%2Ffolder-1%2Fthumbnails_200_200-photo.jpg&id_project=project-1',
        thumbnailDownloadUrl: 'https://public.example/api/files/download?path=uploads%2Fusers%2Fuser-1%2Ffiles%2Ffolder-1%2Fthumbnails_200_200-photo.jpg&id_project=project-1',
      });
    } finally {
      if (fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
    }
  });

  it('preserves signed CDN URLs returned by the chat upload endpoint', async function() {
    const tmpFile = path.join(os.tmpdir(), 'wab-upload-cdn-test.jpg');
    fs.writeFileSync(tmpFile, 'image');

    try {
      const scope = nock('http://internal.example')
        .post('/api/project-1/files/chat')
        .reply(201, {
          filename: 'uploads/users/user-1/files/folder-1/photo.jpg',
          thumbnail: 'uploads/users/user-1/files/folder-1/thumbnails_200_200-photo.jpg',
          cdnUrl: 'https://media.example/files/uploads/users/user-1/files/folder-1/photo.jpg?exp=1&sig=a',
          downloadCdnUrl: 'https://media.example/files/uploads/users/user-1/files/folder-1/photo.jpg?exp=1&disposition=attachment&sig=b',
          thumbnailCdnUrl: 'https://media.example/files/uploads/users/user-1/files/folder-1/thumbnails_200_200-photo.jpg?exp=1&sig=c',
          thumbnailDownloadCdnUrl: 'https://media.example/files/uploads/users/user-1/files/folder-1/thumbnails_200_200-photo.jpg?exp=1&disposition=attachment&sig=d',
        });

      const client = new TiledeskWhatsapp({
        token: 'wa-token',
        GRAPH_URL: 'https://graph.example/',
        API_URL: 'http://internal.example/api',
        BASE_FILE_URL: 'https://public.example/api/'
      });

      const uploadedFile = await client.uploadMedia(tmpFile, 'project-1', 'JWT user-token');

      assert.strictEqual(scope.isDone(), true);
      assert.strictEqual(uploadedFile.cdnUrl, 'https://media.example/files/uploads/users/user-1/files/folder-1/photo.jpg?exp=1&sig=a');
      assert.strictEqual(uploadedFile.downloadCdnUrl, 'https://media.example/files/uploads/users/user-1/files/folder-1/photo.jpg?exp=1&disposition=attachment&sig=b');
      assert.strictEqual(uploadedFile.thumbnailCdnUrl, 'https://media.example/files/uploads/users/user-1/files/folder-1/thumbnails_200_200-photo.jpg?exp=1&sig=c');
      assert.strictEqual(uploadedFile.thumbnailDownloadCdnUrl, 'https://media.example/files/uploads/users/user-1/files/folder-1/thumbnails_200_200-photo.jpg?exp=1&disposition=attachment&sig=d');
      assert.strictEqual(uploadedFile.url, 'https://public.example/api/files?path=uploads%2Fusers%2Fuser-1%2Ffiles%2Ffolder-1%2Fphoto.jpg&id_project=project-1');
    } finally {
      if (fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
    }
  });
});
