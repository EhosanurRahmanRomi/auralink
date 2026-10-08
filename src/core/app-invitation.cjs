'use strict';
// OS protocol handlers deliver untrusted strings. Accept only the public room
// capability format; never navigate the privileged renderer to an external URL.
function parseAppInvitation(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f\\]/.test(value)) return null;
  const match = /^auralink:\/\/join#code=(A1\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) return null;
  const code = match[1]; const key = code.split('.')[2];
  const bytes = Buffer.from(key, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === key ? code : null;
}
module.exports = { parseAppInvitation };
