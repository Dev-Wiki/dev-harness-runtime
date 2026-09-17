import { resolve } from 'node:path';
import { createRepositoryBuildPipeline, distributionPlatforms } from '../build/dist/targets/repository.js';

const [stage, ...args] = process.argv.slice(2);
if (!['generate', 'validate', 'pack'].includes(stage)) throw new Error('Expected generate, validate or pack stage');
let checkout;
let project = process.cwd();
for (let index = 0; index < args.length; index += 1) {
  const key = args[index];
  const value = args[++index];
  if (!value || value.startsWith('-')) throw new Error(`${key} requires a path`);
  if (key === '--protocol-checkout' && checkout === undefined) checkout = resolve(value);
  else if (key === '--project') project = resolve(value);
  else throw new Error(`Unsupported or duplicate option: ${key}`);
}
if (!checkout) throw new Error('--protocol-checkout is required');
const pipeline = await createRepositoryBuildPipeline(project, checkout);
const results = [];
for (const platform of distributionPlatforms) {
  const result = stage === 'generate' ? await pipeline.generate(platform)
    : stage === 'validate' ? await pipeline.validate(platform) : await pipeline.pack(platform);
  if (stage === 'validate' && !result.valid) throw new Error(`${platform} validation failed: ${JSON.stringify(result.checks)}`);
  results.push(stage === 'generate' ? { platform, files: result.files.length }
    : stage === 'validate' ? { platform, valid: result.valid, checks: result.checks.length }
      : { platform, artifacts: result.map(({ file, sha256 }) => ({ file, sha256 })) });
}
process.stdout.write(`${JSON.stringify(results)}\n`);
