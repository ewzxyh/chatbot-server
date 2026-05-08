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

      const fileUrl = await client.uploadMedia(tmpFile, 'project-1', 'JWT user-token');

      assert.strictEqual(scope.isDone(), true);
      assert.strictEqual(fileUrl, 'https://public.example/api/files/download?path=uploads%2Fusers%2Freport.pdf');
    } finally {
      if (fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
    }
  });
});
