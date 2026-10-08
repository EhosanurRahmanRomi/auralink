'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAppInvitation } = require('../src/core/app-invitation.cjs');
const code = 'A1.01234567-89ab-cdef-0123-456789abcdef.' + 'A'.repeat(43);
test('OS invitation accepts only the canonical full public capability', () => {
  assert.equal(parseAppInvitation(`auralink://join#code=${code}`), code);
  assert.equal(parseAppInvitation(`auralink://join/#code=${code}`), null);
  assert.equal(parseAppInvitation(`auralink://join#code=${code.replace('A1.', 'A1%2E')}`), null);
  assert.equal(parseAppInvitation(`auralink://join#code=${code.slice(0, -1)}B`), null);
});
test('OS invitation refuses alternate origins, credentials, actions, queries and malformed capabilities', () => {
  for (const value of [`https://join#code=${code}`, `auralink://other#code=${code}`, `auralink://user@join#code=${code}`,
    `auralink://join:123#code=${code}`, `auralink://join/control#code=${code}`, `auralink://join?approve=1#code=${code}`,
    `auralink://join#code=${code}&control=true`, `auralink://join#code=${code}&code=${code}`, `auralink://join#code=123456`,
    `auralink://join#code=${code}\n`, 'file:///C:/Windows/System32/cmd.exe', undefined]) assert.equal(parseAppInvitation(value), null);
});
