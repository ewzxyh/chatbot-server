function disabled() {
  return process.env.DISABLE_BACKGROUND_WORKERS === true ||
    process.env.DISABLE_BACKGROUND_WORKERS === 'true';
}

module.exports = {
  disabled: disabled
};
