import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runCli } from '../packages/cli/dist/bundle.js';
import { createRepositoryBuildPipeline, distributionPlatforms } from '../build/dist/targets/repository.js';

const stages = new Set(['build', 'validate', 'pack']);
const fail = (message) => { throw new Error(message); };

function argumentsFor(args, release = false) {
  const rest = [];
  let protocolCheckout;
  let project;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--protocol-checkout' || (release && key === '--project')) {
      const value = args[++index];
      if (!value || value.startsWith('-')) fail(`${key} requires a path`);
      if (key === '--protocol-checkout') {
        if (protocolCheckout) fail('Duplicate --protocol-checkout');
        protocolCheckout = resolve(value);
      } else {
        if (project) fail('Duplicate --project');
        project = resolve(value);
      }
    } else if (release && key === '--dry-run') {
      if (dryRun) fail('Duplicate --dry-run');
      dryRun = true;
    } else if (release) fail(`Unsupported release argument: ${key}`);
    else rest.push(key === '--platform' ? '--adapter' : key);
  }
  return { rest, protocolCheckout, project: project ?? process.cwd(), dryRun };
}

/** Trusted repository-only CLI. Plugin-embedded runCli still lacks a build or Executor service. */
export async function runRepositoryCli(args, output, signal) {
  try {
    if (args[0] === 'release') {
      const parsed = argumentsFor(args.slice(1), true);
      if (!parsed.dryRun || !parsed.protocolCheckout) fail('release requires --dry-run and --protocol-checkout PATH');
      const pipeline = await createRepositoryBuildPipeline(parsed.project, parsed.protocolCheckout);
      for (const id of distributionPlatforms) {
        if (signal?.aborted) fail('Release dry-run cancelled');
        await pipeline.generate(id);
        const report = await pipeline.validate(id);
        if (!report.valid) fail(`${id} validation failed: ${JSON.stringify(report.checks)}`);
        await pipeline.pack(id);
      }
      const manifest = JSON.parse(await readFile(resolve(parsed.project, 'dist/manifest.json'), 'utf8'));
      if (manifest.adapterCompatibility.length !== distributionPlatforms.length || manifest.artifacts.length !== 9) {
        fail('Release manifest is missing a platform or artifact');
      }
      output.out(`${JSON.stringify({ dryRun: true, releaseVersion: manifest.releaseVersion,
        sourceCommit: manifest.sourceCommit, manifest: 'dist/manifest.json',
        artifacts: manifest.artifacts.map(({ file, sha256 }) => ({ file, sha256 })) })}\n`);
      return 0;
    }
    if (stages.has(args[0])) {
      const parsed = argumentsFor(args);
      if (!parsed.protocolCheckout) return runCli(parsed.rest, output, { signal });
      const projectFlag = parsed.rest.indexOf('--project');
      const project = projectFlag < 0 ? process.cwd() : resolve(parsed.rest[projectFlag + 1] ?? fail('--project requires a path'));
      const pipeline = await createRepositoryBuildPipeline(project, parsed.protocolCheckout);
      return runCli(parsed.rest, output, { signal, build: pipeline, platforms: pipeline.platforms });
    }
    return runCli(args, output, { signal });
  } catch (error) {
    output.error(`BUILD_FAILED: ${error instanceof Error ? error.message : 'Repository build failed'}\n`);
    return signal?.aborted ? 130 : 4;
  }
}
