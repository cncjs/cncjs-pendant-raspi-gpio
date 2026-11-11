'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('../lib/jwt');

test('a signed token verifies with the same secret', () => {
  const token = jwt.sign({ id: '', name: 'cncjs-pendant' }, 'secret', '30d');
  const payload = jwt.verify(token, 'secret');
  assert.equal(payload.name, 'cncjs-pendant');
  assert.equal(payload.exp - payload.iat, 30 * 86400);
});

test('wrong secret, tampering and garbage are rejected', () => {
  const token = jwt.sign({ name: 'x' }, 'secret');
  assert.throws(() => jwt.verify(token, 'other'), /signature/);
  const [head, , sig] = token.split('.');
  const forged = `${head}.${Buffer.from(JSON.stringify({ name: 'admin' })).toString('base64url')}.${sig}`;
  assert.throws(() => jwt.verify(forged, 'secret'), /signature/);
  assert.throws(() => jwt.verify('', 'secret'), /Malformed/);
  assert.throws(() => jwt.verify(null, 'secret'), /Malformed/);
  assert.throws(() => jwt.verify('a.b.c', 'secret'), /Malformed/);
});

test('unsigned ("alg: none") tokens are rejected', () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.throws(() => jwt.verify(`${b64({ alg: 'none' })}.${b64({ name: 'x' })}.`, 'secret'), /Unsupported/);
});

test('expired tokens are rejected', () => {
  const crypto = require('node:crypto');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ exp: Math.floor(Date.now() / 1000) - 10 })}`;
  const token = `${body}.${crypto.createHmac('sha256', 'secret').update(body).digest('base64url')}`;
  assert.throws(() => jwt.verify(token, 'secret'), /expired/);
});

test('lifetimes accept seconds and time spans', () => {
  assert.equal(jwt.parseLifetime(3600), 3600);
  assert.equal(jwt.parseLifetime('90'), 90);
  assert.equal(jwt.parseLifetime('30m'), 1800);
  assert.equal(jwt.parseLifetime('12h'), 43200);
  assert.equal(jwt.parseLifetime('30d'), 2592000);
  assert.throws(() => jwt.parseLifetime('soon'), /Invalid lifetime/);
  assert.throws(() => jwt.parseLifetime('0'), /Invalid lifetime/);
});
