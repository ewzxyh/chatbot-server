'use strict';

var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var pathlib = require('path');
var sharp = require('sharp');

var BRAZILIAN_AMOUNT = /(?<![\d.])(?:R\$\s*)?(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}(?!\d)/g;

function extractAmountsCents(text) {
  if (typeof text !== 'string') {
    return [];
  }

  return Array.from(text.matchAll(BRAZILIAN_AMOUNT), function(match) {
    return parseInt(
      match[0].replace(/^R\$\s*/, '').replace(/\./g, '').replace(',', ''),
      10
    );
  }).filter(Number.isSafeInteger);
}

function result(status, amountsCents, text, reason) {
  return {
    status: status,
    amountsCents: amountsCents,
    text: text,
    reason: reason
  };
}

function cleanMimeType(mimetype) {
  return String(mimetype || '').split(';')[0].trim().toLowerCase();
}

function expectedAmount(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  var parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function tesseractText(buffer) {
  var tempDirectory;

  try {
    tempDirectory = await fs.promises.mkdtemp(pathlib.join(os.tmpdir(), 'victor-ocr-'));
    var inputPath = pathlib.join(tempDirectory, 'receipt.png');
    await fs.promises.writeFile(inputPath, buffer);

    return await new Promise(function(resolve, reject) {
      childProcess.execFile(
        'tesseract',
        [inputPath, 'stdout', '-l', 'por', '--psm', '6'],
        { maxBuffer: 1024 * 1024, timeout: 30000, windowsHide: true },
        function(error, stdout, stderr) {
          if (error) {
            error.stderr = stderr;
            reject(error);
            return;
          }
          resolve(String(stdout || ''));
        }
      );
    });
  } finally {
    if (tempDirectory) {
      await fs.promises.rm(tempDirectory, { recursive: true, force: true }).catch(function() {});
    }
  }
}

function isTesseractUnavailable(error) {
  return Boolean(
    error &&
    (error.code === 'ENOENT' || /not found|cannot find/i.test(String(error.message || '')))
  );
}

async function runReceiptOcr(options) {
  options = options || {};
  var mimetype = cleanMimeType(options.mimetype);

  if (mimetype === 'application/pdf' || mimetype.indexOf('image/') !== 0) {
    return result('unreadable', [], '', 'unsupported_media');
  }

  if (!Buffer.isBuffer(options.buffer) || options.buffer.length === 0) {
    return result('unreadable', [], '', 'invalid_file');
  }

  var processedBuffer;
  try {
    processedBuffer = await sharp(options.buffer)
      .rotate()
      .grayscale()
      .normalize()
      .png()
      .toBuffer();
  } catch (error) {
    return result('unreadable', [], '', 'invalid_file');
  }

  var text;
  try {
    text = (await tesseractText(processedBuffer)).trim();
  } catch (error) {
    return result(
      'unreadable',
      [],
      '',
      isTesseractUnavailable(error) ? 'tesseract_unavailable' : 'ocr_failed'
    );
  }

  if (!text) {
    return result('unreadable', [], '', 'no_text');
  }

  var amountsCents = extractAmountsCents(text);
  var expected = expectedAmount(options.expectedAmountCents);

  if (!amountsCents.length) {
    return result('unmatched', amountsCents, text, 'amount_not_found');
  }

  if (expected === null) {
    return result('unmatched', amountsCents, text, 'expected_amount_missing');
  }

  var matched = amountsCents.indexOf(expected) !== -1;
  return result(
    matched ? 'matched' : 'unmatched',
    amountsCents,
    text,
    matched ? 'amount_match' : 'amount_mismatch'
  );
}

module.exports = {
  extractAmountsCents: extractAmountsCents,
  runReceiptOcr: runReceiptOcr
};
