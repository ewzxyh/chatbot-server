const pathlib = require('path');
const sharp = require('sharp');

const { buildThumbnailPath } = require('./fileUploadPathBuilder');

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif"];

async function createChatImageThumbnail({
  fileService,
  filename,
  buffer,
  mimetype,
  expireAt,
  setExpiration,
  storeThumbnail,
}) {
  const ext = pathlib.extname(filename || '').toLowerCase();
  if (!IMAGE_EXTENSIONS.includes(ext)) {
    return undefined;
  }

  const thumbnail = buildThumbnailPath(filename);
  const resized = await sharp(buffer).resize(200, 200).toBuffer();
  const metadata = expireAt ? { expireAt } : undefined;

  if (storeThumbnail) {
    await storeThumbnail(thumbnail, resized, mimetype, metadata);
  } else {
    const options = metadata ? { metadata } : undefined;
    await fileService.createFile(thumbnail, resized, undefined, mimetype, options);
  }

  if (setExpiration && expireAt) {
    await setExpiration(await fileService.find(thumbnail), expireAt);
  }

  return thumbnail;
}

module.exports = {
  createChatImageThumbnail,
};
