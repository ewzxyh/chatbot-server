const pathlib = require('path');
const uuidv4 = require('uuid/v4');

function safeFilename(originalname) {
  return pathlib.basename(String(originalname || 'file').replace(/\\/g, '/'));
}

function buildChatFilePath({ userId, folderName, folder, originalname }) {
  const subfolder = userId ? `/users/${userId}` : '/public';
  const uploadFolder = folder || uuidv4();
  return `uploads${subfolder}/${folderName}/${uploadFolder}/${safeFilename(originalname)}`;
}

function buildProjectAssetPath({ projectId, folderName, folder, originalname }) {
  if (!projectId) {
    throw new Error('Project is required for asset upload');
  }
  const uploadFolder = folder || uuidv4();
  return `uploads/projects/${projectId}/${folderName}/${uploadFolder}/${safeFilename(originalname)}`;
}

function buildAvatarPath({ entityId }) {
  return `uploads/users/${entityId}/images/photo.jpg`;
}

function buildThumbnailPath(filename) {
  return filename.replace(/([^/]+)$/, 'thumbnails_200_200-$1');
}

module.exports = {
  buildAvatarPath,
  buildChatFilePath,
  buildProjectAssetPath,
  buildThumbnailPath,
};
