'use strict';

// Minimal HS256 JSON Web Token sign/verify, compatible with the tokens CNCjs
// issues and accepts. Uses node:crypto so no extra dependency is needed.

const crypto = require('node:crypto');

const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const decode = (str) => JSON.parse(Buffer.from(str, 'base64url').toString('utf8'));
const hmac = (data, secret) => crypto.createHmac('sha256', String(secret)).update(data).digest();

// 3600, "3600", "30m", "12h", "30d" -> seconds
function parseLifetime(value) {
  const match = /^(\d+)\s*([smhd]?)$/.exec(String(value).trim());
  if (!match || Number(match[1]) <= 0) {
    throw new Error(`Invalid lifetime "${value}" (use seconds, or e.g. 30m, 12h, 30d)`);
  }
  return Number(match[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[match[2]];
}

function sign(payload, secret, lifetime = '30d') {
  const now = Math.floor(Date.now() / 1000);
  const claims = { ...payload, iat: now, exp: now + parseLifetime(lifetime) };
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`;
  return `${body}.${hmac(body, secret).toString('base64url')}`;
}

// Returns the payload, or throws if the token is malformed, forged or expired.
function verify(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed token');
  }

  let header;
  let payload;
  try {
    header = decode(parts[0]);
    payload = decode(parts[1]);
  } catch (err) {
    throw new Error('Malformed token');
  }
  if (!header || header.alg !== 'HS256' || !payload || typeof payload !== 'object') {
    throw new Error('Unsupported token');
  }

  const expected = hmac(`${parts[0]}.${parts[1]}`, secret);
  const given = Buffer.from(parts[2], 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new Error('Bad token signature');
  }
  if (typeof payload.exp === 'number' && payload.exp < Date.now() / 1000) {
    throw new Error('Token expired');
  }
  return payload;
}

module.exports = { sign, verify, parseLifetime };
