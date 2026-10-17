import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../accounts/src/store.js';
import { seed, STARTER_COMMUNITIES, CATEGORIES } from '../src/seed.js';

function freshStore() {
  return new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'blk-seed-')));
}

test('seed creates the system account, official communities, and the welcome post', async () => {
  const store = freshStore();
  const r = await seed(store, () => 1000);
  assert.equal(r.profile, true);
  assert.equal(r.communities, STARTER_COMMUNITIES.length);
  assert.equal(r.welcome, true);

  // system handle + profile
  assert.equal(store.get('handles', 'blockle'), 'blockle-system');
  assert.equal(store.get('profiles', 'blockle-system').official, true);

  // every starter community exists, is official, and has a valid category
  for (const c of STARTER_COMMUNITIES) {
    const row = store.get('communities', c.name);
    assert.ok(row, 'community ' + c.name);
    assert.equal(row.official, true);
    assert.ok(CATEGORIES.includes(row.category));
    assert.equal(row.ownerUid, 'blockle-system');
  }

  // welcome post lives in announcements, authored by the system account
  const posts = store.all('posts');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].cid, 'announcements');
  assert.equal(posts[0].uid, 'blockle-system');
});

test('seed is idempotent — a second run creates nothing new', async () => {
  const store = freshStore();
  await seed(store, () => 1000);
  const r2 = await seed(store, () => 2000);
  assert.deepEqual(r2, { profile: false, communities: 0, welcome: false });
  assert.equal(store.all('communities').length, STARTER_COMMUNITIES.length);
  assert.equal(store.all('posts').length, 1);
});
