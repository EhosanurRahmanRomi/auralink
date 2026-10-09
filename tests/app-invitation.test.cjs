'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAppInvitation } = require('../src/core/app-invitation.cjs');
const code = 'A1.01234567-89ab-cdef-0123-456789abcdef.' + 'A'.repeat(43);
test('OS invitation accepts only the canonical full public capability', () => {
  for(const scheme of ['glance-port', 'auralink']) {
    assert.equal(parseAppInvitation(`${scheme}://join#code=${code}`), code);
    assert.equal(parseAppInvitation(`${scheme}://join/#code=${code}`), null);
    assert.equal(parseAppInvitation(`${scheme}://join#code=${code.replace('A1.', 'A1%2E')}`), null);
    assert.equal(parseAppInvitation(`${scheme}://join#code=${code.slice(0, -1)}B`), null);
  }
});
test('OS invitation refuses alternate origins, credentials, actions, queries and malformed capabilities', () => {
  for(const scheme of ['glance-port', 'auralink']) for (const value of [`https://join#code=${code}`, `${scheme}://other#code=${code}`, `${scheme}://user@join#code=${code}`,
    `${scheme}://join:123#code=${code}`, `${scheme}://join/control#code=${code}`, `${scheme}://join?approve=1#code=${code}`,
    `${scheme}://join#code=${code}&control=true`, `${scheme}://join#code=${code}&code=${code}`, `${scheme}://join#code=123456`,
    `${scheme}://join#code=${code}\n`, `${scheme.toUpperCase()}://join#code=${code}`, 'file:///C:/Windows/System32/cmd.exe', undefined]) assert.equal(parseAppInvitation(value), null);
});
