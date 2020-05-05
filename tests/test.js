/* eslint-disable no-undef */
/* eslint-disable no-console */

const path = require('path');
const parseConfigFile = require('../parse-config-file');

function read(filename) {
  return parseConfigFile(path.resolve(__dirname, filename));
}

test('read buildConfigs from shadow-cljs config file', async () => {
  const { buildConfigs } = await read('shadow-cljs.edn');

  expect(buildConfigs.length).toBe(2);

  expect(buildConfigs[0].target).toBe('node-library');
  expect(buildConfigs[0].name).toBe('haikus');
  expect(buildConfigs[1].target).toBe('browser');
});

test('read :now options from shadow-cljs.edn', async () => {
  const { options } = await read('shadow-cljs.edn');

  expect(options.dev.compile).toBe('release');
});

test('provide default :now options from shadow-cljs.edn', async () => {
  const { options } = await read('empty-shadow-cljs.edn');

  expect(options.dev.compile).toBe('compile');
});
