const FileGridFsService = require('./fileGridFsService');
const R2FileService = require('./r2FileService');

function isObjectStorageEnabled() {
  return R2FileService.isEnabled();
}

function createPrimaryFileService(bucketName) {
  if (isObjectStorageEnabled()) {
    return new R2FileService(bucketName);
  }
  return new FileGridFsService(bucketName);
}

function createLegacyFallbackFileServices(bucketNames) {
  return bucketNames.map((bucketName) => new FileGridFsService(bucketName));
}

module.exports = {
  createLegacyFallbackFileServices,
  createPrimaryFileService,
  isObjectStorageEnabled,
};
