'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const workflow = readFileSync(resolve(__dirname, '../.github/workflows/claude-builder.yml'), 'utf8').replace(/\r\n/g, '\n');
const claudeStep = workflow.split('      - id: claude\n')[1]?.split('\n      - name:')[0];
assert.ok(claudeStep, 'identify the actual Builder Claude action step');
const args = claudeStep.split('          claude_args: >-\n')[1];
assert.ok(args, 'Builder must explicitly configure Claude arguments');

test('Builder excludes repository project and local settings before tool startup (#37)', () => {
  assert.match(args, /^            --setting-sources user$/m);
  assert.equal((args.match(/--setting-sources\b/g) || []).length, 1);
});

test('Builder exclusively loads the central empty MCP configuration (#37)', () => {
  assert.match(args, /^            --strict-mcp-config$/m);
  const configs = [...args.matchAll(/^            --mcp-config '([^']+)'$/gm)];
  assert.equal(configs.length, 1, 'one central inline configuration, no repository path');
  assert.deepEqual(JSON.parse(configs[0][1]), { mcpServers: {} });
});

test('Builder keeps action-provided MCP installation disabled (#37)', () => {
  assert.doesNotMatch(claudeStep, /^          (plugins|plugin_marketplaces|use_commit_signing):/m);
  assert.match(args, /--allowedTools "Read,Glob,Grep,Edit,Write,Bash"/);
  assert.doesNotMatch(args, /mcp__|--plugin-dir|--plugin-url|--dangerously-skip-permissions/);
  assert.match(claudeStep, /show_full_output: 'false'/);
});
