import { spawnSync } from 'node:child_process';
const PIN = 'bf943f80fec5ac647159d26161446ac5d716a294';
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout: 180000 });
  if (result.error || result.status !== 0) throw new Error(`Safe integration prerequisite/command failed: ${command}`);
  return result.stdout?.trim();
}
if (run('git', ['-C', 'vendor/safe', 'rev-parse', 'HEAD'], true) !== PIN) throw new Error('Safe source must match the reviewed v1.4.1 pin.');
if (run('git', ['-C', 'vendor/safe', 'status', '--porcelain'], true)) throw new Error('Safe source must be clean.');
// The Safe marketplace/policy suite deploys the console's own collection and test validator artifacts.
run(process.execPath, ['node_modules/hardhat/internal/cli/cli.js', 'compile']);
run(process.execPath, ['node_modules/hardhat/internal/cli/cli.js', 'test', '--config', 'test-safe/config.cjs']);
