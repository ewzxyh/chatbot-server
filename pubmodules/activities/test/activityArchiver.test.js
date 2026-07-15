const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const activityArchiverPath = path.resolve(__dirname, '..', 'activityArchiver');
const authEventPath = path.resolve(__dirname, '../../../event/authEvent');

function assertActivityArchivingState(flagValue, expected) {
  const env = { ...process.env, EXPECT_ACTIVITY_ARCHIVING: String(expected) };

  if (flagValue === undefined) {
    delete env.ACTIVITY_HISTORY_ENABLED;
  } else {
    env.ACTIVITY_HISTORY_ENABLED = flagValue;
  }

  delete env.MONGOOSE_SYNCINDEX;

  const script = `
    const authEvent = require(${JSON.stringify(authEventPath)});
    const activityArchiver = require(${JSON.stringify(activityArchiverPath)});
    const before = authEvent.listenerCount('project_user.invite');

    activityArchiver.listen();
    const afterFirstListen = authEvent.listenerCount('project_user.invite');
    activityArchiver.listen();

    const enabled = afterFirstListen > before;
    if (enabled !== (process.env.EXPECT_ACTIVITY_ARCHIVING === 'true')) {
      process.exitCode = 1;
    }
    if (authEvent.listenerCount('project_user.invite') !== afterFirstListen) {
      process.exitCode = 1;
    }
  `;

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '../../..'),
    env,
    encoding: 'utf8'
  });

  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
}

describe('ActivityArchiver', function() {
  it('archives activities when the flag is omitted', function() {
    assertActivityArchivingState(undefined, true);
  });

  it('allows explicit opt-out with false', function() {
    assertActivityArchivingState('false', false);
  });
});
