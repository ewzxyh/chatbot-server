process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

const assert = require('assert');
const childProcess = require('child_process');
const sharp = require('sharp');
const { extractAmountsCents, runReceiptOcr } = require('../../pubmodules/casezap/victorOcr');

describe('CaseZap victorOcr', function() {
  let originalExecFile;

  beforeEach(function() {
    originalExecFile = childProcess.execFile;
  });

  afterEach(function() {
    childProcess.execFile = originalExecFile;
  });

  async function imageBuffer() {
    return sharp({
      create: {
        width: 1,
        height: 1,
        channels: 3,
        background: '#ffffff'
      }
    }).png().toBuffer();
  }

  it('extracts Brazilian amounts in cents', function() {
    assert.deepStrictEqual(
      extractAmountsCents('Total R$ 1.234,56; entrada 123,45.'),
      [123456, 12345]
    );
  });

  it('returns unmatched when OCR amount differs from expected', async function() {
    childProcess.execFile = function(command, args, options, callback) {
      assert.strictEqual(command, 'tesseract');
      assert.deepStrictEqual(args.slice(2, 5), ['-l', 'por', '--psm']);
      process.nextTick(function() {
        callback(null, 'Total R$ 1.234,56\n', '');
      });
    };

    var result = await runReceiptOcr({
      buffer: await imageBuffer(),
      mimetype: 'image/png',
      expectedAmountCents: 12345
    });

    assert.strictEqual(result.status, 'unmatched');
    assert.deepStrictEqual(result.amountsCents, [123456]);
    assert.strictEqual(result.reason, 'amount_mismatch');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(result, 'approved'), false);
  });

  it('returns unreadable when tesseract is unavailable', async function() {
    childProcess.execFile = function(command, args, options, callback) {
      var error = new Error('spawn tesseract ENOENT');
      error.code = 'ENOENT';
      process.nextTick(function() {
        callback(error, '', '');
      });
    };

    var result = await runReceiptOcr({
      buffer: await imageBuffer(),
      mimetype: 'image/png',
      expectedAmountCents: 12345
    });

    assert.deepStrictEqual(result, {
      status: 'unreadable',
      amountsCents: [],
      text: '',
      reason: 'tesseract_unavailable'
    });
  });

  it('returns graceful reasons for invalid images and PDFs', async function() {
    var invalid = await runReceiptOcr({
      buffer: Buffer.from('not an image'),
      mimetype: 'image/png'
    });
    var pdf = await runReceiptOcr({
      buffer: Buffer.from('%PDF-1.7'),
      mimetype: 'application/pdf'
    });

    assert.strictEqual(invalid.status, 'unreadable');
    assert.strictEqual(invalid.reason, 'invalid_file');
    assert.strictEqual(pdf.status, 'unreadable');
    assert.strictEqual(pdf.reason, 'unsupported_media');
  });
});
