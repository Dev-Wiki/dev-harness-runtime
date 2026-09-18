import { createHash } from 'node:crypto';
import type { GitCommitPolicy } from '@dev-harness-runtime/core';
import { CodexRuntimeError } from './runtime-adapter.js';

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function unsupported(message: string): never { throw new CodexRuntimeError('CAPABILITY_MISSING', message); }
function reject(message: string): never { throw new CodexRuntimeError('AUTHORIZATION_VIOLATION', message); }

/** Interpret only the confirmed dev-harness-git-workflow Conventional Commits template. */
export const codexConventionalCommitPolicy: GitCommitPolicy = {
  async evaluate({ workflow, result }) {
    if (!/(?:^|\/)GIT_WORKFLOW\.md$/u.test(workflow.path) || digest(workflow.bytes) !== workflow.sha256) {
      reject('Frozen Git Workflow source is missing or changed');
    }
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(workflow.bytes); }
    catch { return unsupported('Frozen Git Workflow is not UTF-8'); }
    const heading = /^## 提交规范\s*\r?$/gmu.exec(text);
    if (!heading) unsupported('Git Workflow has no supported commit section');
    const tail = text.slice(heading.index + heading[0].length).replace(/^\r?\n/u, '');
    const next = /^##\s/u.exec(tail) ? 0 : tail.search(/^##\s/gmu);
    const section = next < 0 ? tail : tail.slice(0, next);
    if (!/使用 Conventional Commits/u.test(section)
      || !/```text\s*\r?\n<type>\(<scope>\): <中文描述>\r?\n```/u.test(section)) {
      unsupported('Git Workflow does not declare the supported Conventional Commits template');
    }
    const types = [...section.matchAll(/^\s*-\s*`([a-z]+)`\s*$/gmu)].map((match) => match[1]!);
    if (types.length === 0 || new Set(types).size !== types.length) {
      unsupported('Git Workflow does not declare unique commit types');
    }
    const intent = result.commitIntent;
    if (!intent || typeof intent.message !== 'string' || Buffer.byteLength(intent.message) > 256
      || intent.message.includes('\0')
      || !/^[a-z]+(?:\([a-z0-9][a-z0-9-]*\))?: [^\r\n]+\n$/u.test(intent.message)) {
      reject('Worker commit intent needs one LF-terminated Conventional Commit subject');
    }
    const match = /^([a-z]+)(?:\([a-z0-9][a-z0-9-]*\))?: (.+)\n$/u.exec(intent.message);
    if (!match || !types.includes(match[1]!) || !/\p{Script=Han}/u.test(match[2]!)) {
      reject('Worker commit subject does not follow the frozen project template');
    }
    return { message: intent.message, paths: [...intent.paths] };
  },
};
