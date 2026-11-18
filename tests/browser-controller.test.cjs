const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserController, matchesProfileIdentity } = require('../electron/browser-controller.cjs');
const EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const entry = (patch = {}) => ({ browser: 'Chrome', profile: 'Profile 1', launchUrl: '', ...patch });
const window = (patch = {}) => ({ hwnd: '10001', pid: 100, processStartedAt: '638999900000000000', executable: EXE, profile: 'Profile 1', ...patch });
const record = value => ({ ...value, token: '12345678-1234-4234-8234-123456789abc' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('persisted window identities require a current explicit Chromium Profile and matching browser', () => {
  for (const [browser, filename] of [['Chrome', 'chrome.exe'], ['Edge', 'msedge.exe'], ['Brave', 'brave.exe']]) {
    const candidate = window({ executable: `C:\\Browser\\${filename}`, profile: 'Profile+21' });
    assert.equal(matchesProfileIdentity(entry({ browser, profile: 'Profile+21', browserWindow: candidate })), true);
    assert.equal(matchesProfileIdentity(entry({ browser, profile: 'Profile 21', browserWindow: candidate })), false);
    assert.equal(matchesProfileIdentity(entry({ browser, profile: '', browserWindow: candidate })), false);
    assert.equal(matchesProfileIdentity(entry({ browser, profile: 'Profile+21', browserWindow: { ...candidate, profile: '' } })), false);
    assert.equal(matchesProfileIdentity(entry({ browser, profile: 'Profile+21', browserWindow: { ...candidate, executable: 'C:\\Browser\\firefox.exe' } })), false);
  }
  assert.equal(matchesProfileIdentity(entry({ profile: '21', browserWindow: window({ profile: 'Profile 21' }) })), true);
  assert.equal(matchesProfileIdentity(entry({ browser: 'Firefox', profile: 'Work+Mail', browserWindow: window({ profile: 'Work+Mail' }) })), false);
  assert.equal(matchesProfileIdentity(entry({ browser: '系统默认', browserWindow: window() })), false);
  assert.equal(matchesProfileIdentity(null), false);
});
test('a plus-named Profile is matched to its own window rather than a space-named Profile', async () => {
  const plus = window({ hwnd: '210', profile: 'Profile+21' });
  const space = window({ hwnd: '211', profile: 'Profile 21' });
  let launched = false;
  const controller = createBrowserController({
    adapter: { snapshot: async () => launched ? [space, plus] : [], tagWindow: async value => record(value) },
    launcher: { launch: async () => { launched = true; return { executable: EXE }; } }, wait: async () => {}
  });
  const result = await controller.launch(entry({ profile: 'Profile+21' }), {});
  assert.equal(result.record.hwnd, plus.hwnd); assert.equal(result.record.profile, 'Profile+21');
  assert.equal(result.warning, '');
});

test('Firefox, system-default routing and unspecified Chromium profiles launch without guessed window ownership', async () => {
  const cases = [
    { browser: 'Firefox', profile: 'Work+Mail', executable: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe' },
    { browser: '系统默认', profile: 'Profile+21', executable: EXE },
    ...['Chrome', 'Edge', 'Brave'].map(browser => ({ browser, profile: '', executable: EXE }))
  ];
  for (const { browser, profile, executable } of cases) {
    let scans = 0, launches = 0, tags = 0;
    const api = createBrowserController({ wait: async () => {},
      adapter: { snapshot: async () => { scans++; return []; }, tagWindow: async () => { tags++; throw new Error('must not tag'); } },
      launcher: { launch: async value => { launches++; assert.equal(value.profile, profile); return { executable, pid: 9999 }; } } });
    const result = await api.launch(entry({ browser, profile }), {});
    assert.equal(launches, 1); assert.equal(scans, 1); assert.equal(tags, 0);
    assert.equal(result.record, null); assert.equal(result.reason, 'identity');
    assert.match(result.warning, /只启动浏览器/);
  }
});

test('an explicit Chromium Profile never adopts a new window with missing or mismatched metadata', async () => {
  for (const profile of [undefined, '', 'Profile 21', 'Profile+210', 'Profile 1']) {
    let launched = false, tags = 0;
    const controller = createBrowserController({ wait: async () => {},
      adapter: { snapshot: async () => launched ? [window({ profile })] : [], tagWindow: async () => { tags++; throw new Error('must not tag'); } },
      launcher: { launch: async () => { launched = true; return { executable: EXE, pid: 9999 }; } } });
    const result = await controller.launch(entry({ profile: 'Profile+21' }), {});
    assert.equal(result.record, null); assert.equal(tags, 0); assert.equal(result.reason, 'timeout');
  }
});

test('only the exact requested Profile is eligible among known, unknown and mismatched new windows', async () => {
  const matching = window({ hwnd: '210', profile: 'Profile+21' });
  const unknown = window({ hwnd: '211', profile: '' });
  const mismatched = window({ hwnd: '212', profile: 'Profile 21' });
  let launched = false;
  const tagged = [];
  const controller = createBrowserController({ wait: async () => {},
    adapter: { snapshot: async () => launched ? [unknown, mismatched, matching] : [], tagWindow: async value => { tagged.push(value); return record(value); } },
    launcher: { launch: async () => { launched = true; return { executable: EXE }; } } });
  const result = await controller.launch(entry({ profile: 'Profile+21' }), {});
  assert.deepEqual(tagged, [matching]); assert.equal(result.record.hwnd, matching.hwnd);
});

test('only a stable new matching browser and Profile is tagged, regardless of the short-lived launcher PID', async () => {
  const old = window(), chosen = window({ hwnd: '20002', pid: 200 });
  const unrelated = window({ hwnd: '30003', profile: 'Profile 9' });
  const otherBrowser = window({ hwnd: '40004', executable: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' });
  let launched = false;
  const tagged = [];
  const controller = createBrowserController({
    adapter: {
      snapshot: async () => launched ? [old, unrelated, otherBrowser, chosen] : [old],
      tagWindow: async value => { tagged.push(value); return record(value); }
    },
    launcher: { launch: async () => { launched = true; return { executable: EXE, pid: 9999 }; } },
    wait: async () => {}
  });
  const result = await controller.launch(entry({ profile: '1' }), {});
  assert.deepEqual(tagged, [chosen]); assert.deepEqual(result.record, record(chosen));
  assert.equal(result.record.pid, 200); assert.notEqual(result.record.pid, 9999); assert.equal(result.warning, '');
});

test('ambiguous simultaneous windows are left untracked rather than choosing one to close later', async () => {
  let launched = false, tags = 0;
  const controller = createBrowserController({
    adapter: { snapshot: async () => launched ? [window(), window({ hwnd: '20002' })] : [],
      tagWindow: async () => { tags++; throw new Error('must not tag'); } },
    launcher: { launch: async () => { launched = true; return { executable: EXE }; } }, wait: async () => {}
  });
  const result = await controller.launch(entry(), {});
  assert.equal(result.record, null); assert.match(result.warning, /未能安全识别/); assert.equal(result.reason, 'ambiguous'); assert.equal(tags, 0);
});

test('transient windows are not tagged without two consistent observations', async () => {
  const sequence = [[], [window()], [], [window({ hwnd: '20002' })]];
  let tags = 0;
  const controller = createBrowserController({
    adapter: { snapshot: async () => sequence.shift(), tagWindow: async () => { tags++; } },
    launcher: { launch: async () => ({ executable: EXE }) }, wait: async () => {}, discoveryAttempts: 3
  });
  const result = await controller.launch(entry(), {});
  assert.equal(result.record, null); assert.equal(result.reason, 'timeout'); assert.equal(tags, 0);
});

test('window-helper failure still permits browser launch and returns an explicit untracked result', async () => {
  for (const failBefore of [true, false]) {
    let snapshots = 0, launches = 0, tags = 0;
    const controller = createBrowserController({
      adapter: { snapshot: async () => { snapshots++; if (failBefore || snapshots > 1) throw new Error('native unavailable'); return []; },
        tagWindow: async () => { tags++; } },
      launcher: { launch: async () => { launches++; return { executable: EXE }; } }, wait: async () => {}
    });
    const result = await controller.launch(entry(), {});
    assert.equal(launches, 1); assert.equal(tags, 0); assert.equal(result.record, null); assert.match(result.warning, /未能安全识别/);
    assert.equal(result.reason, failBefore ? 'baseline' : 'scan');
    assert.doesNotMatch(result.warning, /native unavailable/);
  }
});

test('unresolvable system-default launch does not attach a random supported-browser window', async () => {
  let tags = 0;
  const controller = createBrowserController({
    adapter: { snapshot: async () => [], tagWindow: async () => { tags++; } },
    launcher: { launch: async () => ({ executable: null }) }, wait: async () => {}
  });
  const result = await controller.launch(entry({ browser: '系统默认' }), {});
  assert.equal(result.record, null); assert.equal(tags, 0); assert.ok(result.warning); assert.equal(result.reason, 'unsupported');
});

test('unsupported or relative system-default executables are not associated with a supported window', async () => {
  for (const executable of ['C:\\Browsers\\opera.exe', 'chrome.exe']) {
    let scans = 0, tags = 0;
    const controller = createBrowserController({
      adapter: { snapshot: async () => { scans++; return [window()]; }, tagWindow: async () => { tags++; } },
      launcher: { launch: async () => ({ executable }) }, wait: async () => {}
    });
    const result = await controller.launch(entry({ browser: '系统默认' }), {});
    assert.equal(result.reason, 'unsupported'); assert.equal(result.record, null);
    assert.equal(scans, 1); assert.equal(tags, 0); assert.doesNotMatch(result.warning, /C:\\Browsers/);
  }
});

test('a slow new browser window can stabilize on the final two default discovery checks', async () => {
  let scans = 0;
  const waits = [], tagged = [];
  const controller = createBrowserController({
    adapter: { snapshot: async () => ++scans >= 8 ? [window()] : [], tagWindow: async value => { tagged.push(value); return record(value); } },
    launcher: { launch: async () => ({ executable: EXE }) }, wait: async duration => { waits.push(duration); }
  });
  const result = await controller.launch(entry(), {});
  assert.ok(result.record); assert.deepEqual(tagged, [window()]);
  assert.equal(scans, 9); assert.deepEqual(waits, Array(7).fill(200));
});

test('a pre-existing same-Profile window is never adopted when no new window appears', async () => {
  let scans = 0, tags = 0;
  const controller = createBrowserController({
    adapter: { snapshot: async () => { scans++; return [window()]; }, tagWindow: async () => { tags++; } },
    launcher: { launch: async () => ({ executable: EXE, pid: 100 }) }, wait: async () => {}
  });
  const result = await controller.launch(entry(), {});
  assert.equal(result.reason, 'timeout'); assert.equal(result.record, null); assert.equal(tags, 0); assert.equal(scans, 9);
});

test('a transient tagging failure retries only the same stable new window after another snapshot', async () => {
  const old = window({ hwnd: '900' }), chosen = window({ hwnd: '901' });
  const events = [];
  let scans = 0, tags = 0;
  const controller = createBrowserController({
    adapter: { snapshot: async () => { events.push('scan'); return scans++ ? [old, chosen] : [old]; },
      tagWindow: async value => { events.push(`tag:${value.hwnd}`); tags++; if (tags === 1) throw new Error('access temporarily denied'); return record(value); } },
    launcher: { launch: async () => ({ executable: EXE }) }, wait: async () => {}
  });
  const result = await controller.launch(entry(), {});
  assert.equal(result.record.hwnd, chosen.hwnd); assert.equal(result.warning, ''); assert.equal(tags, 2);
  assert.deepEqual(events, ['scan', 'scan', 'scan', 'tag:901', 'scan', 'tag:901']);
});

test('tagging stops after two failures without exposing the native error', async () => {
  let scans = 0, tags = 0;
  const controller = createBrowserController({
    adapter: { snapshot: async () => scans++ ? [window()] : [], tagWindow: async () => { tags++; throw new Error('sensitive internal detail'); } },
    launcher: { launch: async () => ({ executable: EXE }) }, wait: async () => {}
  });
  const result = await controller.launch(entry(), {});
  assert.equal(result.reason, 'tag'); assert.equal(result.record, null); assert.equal(tags, 2); assert.equal(scans, 4);
  assert.doesNotMatch(result.warning, /sensitive internal detail/);
});

test('a failed tagging attempt never transfers to a missing, replaced or different executable window', async () => {
  const variants = [null, window({ hwnd: '10002' }), window({ pid: 101 }), window({ processStartedAt: '638999900000000001' }), window({ executable: 'C:\\Other Chrome\\chrome.exe' })];
  for (const replacement of variants) {
    let scans = 0, tags = 0;
    const controller = createBrowserController({
      adapter: { snapshot: async () => { scans++; return scans === 1 ? [] : scans <= 3 ? [window()] : replacement ? [replacement] : []; },
        tagWindow: async value => { tags++; assert.deepEqual(value, window()); throw new Error('retry later'); } },
      launcher: { launch: async () => ({ executable: EXE }) }, wait: async () => {}
    });
    const result = await controller.launch(entry(), {});
    assert.equal(result.reason, 'tag'); assert.equal(result.record, null); assert.equal(tags, 1);
  }
});

test('new ambiguity after a failed tag prevents retrying either candidate', async () => {
  let scans = 0, tags = 0;
  const controller = createBrowserController({
    adapter: { snapshot: async () => { scans++; return scans === 1 ? [] : scans <= 3 ? [window()] : [window(), window({ hwnd: '10002' })]; },
      tagWindow: async () => { tags++; throw new Error('retry later'); } },
    launcher: { launch: async () => ({ executable: EXE }) }, wait: async () => {}
  });
  const result = await controller.launch(entry(), {});
  assert.equal(result.reason, 'ambiguous'); assert.equal(result.record, null); assert.equal(tags, 1);
});

test('concurrent launches are serialized through discovery and tagging before the next baseline', async () => {
  const firstGate = deferred(), firstStarted = deferred(), current = [], events = [];
  const controller = createBrowserController({
    adapter: {
      snapshot: async () => [...current],
      tagWindow: async value => { events.push(`tag:${value.profile}`); return record(value); }
    },
    launcher: { launch: async value => {
      events.push(`launch:${value.profile}`);
      if (value.profile === 'Profile 1') { firstStarted.resolve(); await firstGate.promise; }
      current.push(window({ hwnd: String(10000 + current.length), profile: value.profile }));
      return { executable: EXE };
    } }, wait: async () => {}
  });
  const first = controller.launch(entry(), {});
  await firstStarted.promise;
  const second = controller.launch(entry({ profile: 'Profile 2' }), {});
  await Promise.resolve();
  assert.deepEqual(events, ['launch:Profile 1']);
  firstGate.resolve();
  const results = await Promise.all([first, second]);
  assert.deepEqual(events, ['launch:Profile 1', 'tag:Profile 1', 'launch:Profile 2', 'tag:Profile 2']);
  assert.equal(results[0].record.profile, 'Profile 1'); assert.equal(results[1].record.profile, 'Profile 2');
});

test('launcher failure releases the discovery queue for the next account', async () => {
  let successfulLaunch = false;
  const controller = createBrowserController({
    adapter: { snapshot: async () => successfulLaunch ? [window()] : [], tagWindow: async value => record(value) },
    launcher: { launch: async value => { if (value.profile === 'bad') throw new Error('browser missing'); successfulLaunch = true; return { executable: EXE }; } },
    wait: async () => {}
  });
  const failed = controller.launch(entry({ profile: 'bad' }), {});
  const next = controller.launch(entry(), {});
  await assert.rejects(failed, /browser missing/); assert.ok((await next).record);
});

test('locking rejects queued launches before any additional OS launch', async () => {
  const firstGate = deferred(), firstStarted = deferred(), current = [], launched = [];
  let secondUnlocked = true;
  const controller = createBrowserController({
    adapter: { snapshot: async () => [...current], tagWindow: async value => record(value) },
    launcher: { launch: async value => {
      launched.push(value.profile); firstStarted.resolve(); await firstGate.promise;
      current.push(window()); return { executable: EXE };
    } }, wait: async () => {}
  });
  const first = controller.launch(entry(), {});
  await firstStarted.promise;
  const second = controller.launch(entry({ profile: 'Profile 2' }), {}, () => { if (!secondUnlocked) throw new Error('locked'); });
  const rejected = assert.rejects(second, /locked/);
  secondUnlocked = false; firstGate.resolve(); await first; await rejected;
  assert.deepEqual(launched, ['Profile 1']);
});

test('locking during baseline or discovery stops the next launch or association step', async () => {
  for (const stage of ['baseline', 'discovery']) {
    let unlocked = true, snapshots = 0, launched = 0, tags = 0;
    const controller = createBrowserController({
      adapter: { snapshot: async () => {
        snapshots++; if (snapshots === (stage === 'baseline' ? 1 : 2)) unlocked = false;
        return snapshots > 1 ? [window()] : [];
      }, tagWindow: async value => { tags++; return record(value); } },
      launcher: { launch: async () => { launched++; return { executable: EXE }; } }, wait: async () => {}
    });
    await assert.rejects(controller.launch(entry(), {}, () => { if (!unlocked) throw new Error('locked'); }), /locked/);
    assert.equal(launched, stage === 'baseline' ? 0 : 1); assert.equal(tags, 0);
  }
});

test('locking during a successful or failed tag stops association and retry', async () => {
  for (const fails of [false, true]) {
    let scans = 0, tags = 0, unlocked = true;
    const controller = createBrowserController({
      adapter: { snapshot: async () => scans++ ? [window()] : [], tagWindow: async value => {
        tags++; unlocked = false;
        if (fails) throw new Error('tag failed');
        return record(value);
      } },
      launcher: { launch: async () => ({ executable: EXE }) }, wait: async () => {}
    });
    await assert.rejects(controller.launch(entry(), {}, () => { if (!unlocked) throw new Error('locked'); }), /locked/);
    assert.equal(tags, 1); assert.equal(scans, 3);
  }
});
