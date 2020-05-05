const debug = require('debug')('shadow:parse');

const fs = require('fs-extra');
const edn = require('jsedn');

const supportedBuildTypes = [':browser', ':node-library'];

debug.enabled = true;

// Handle/ignore shadow/env tagged value
edn.setTagAction(new edn.Tag('shadow', 'env'), (obj) => {
  return obj;
});

function keywordToString(kw) {
  return kw && kw.replace(':', '');
}

function prepareOptions(rawOptions) {
  const options = {
    dev: {
      compile: 'compile',
    },
  };

  if (!rawOptions) {
    return options;
  }

  if (rawOptions[':dev']) {
    const dev = rawOptions[':dev'];
    if (dev[':compile']) {
      options.dev.compile = dev[':compile'];
    }
  }

  return options;
}

async function parseAndFilterShadowCljsBuilds(input) {
  debug('Reading shadow-cljs config...');
  const entrypointFile = await fs.readFile(input, 'utf8');

  // Parse edn to js
  const shadowCljsConfig = edn.toJS(edn.parse(entrypointFile));

  // Filter builds that are supported by this builder
  const supportedBuildConfigs = Object.entries(shadowCljsConfig[':builds']).filter(([, config]) =>
    supportedBuildTypes.includes(config[':target'])
  );

  const buildConfigs = supportedBuildConfigs.map(([name, config]) => ({
    name: keywordToString(name),
    target: keywordToString(config[':target']),
    assetPath: config[':asset-path'],
    outputDir: config[':output-dir'],
    outputTo: config[':output-to'],
  }));

  const rawOptions = shadowCljsConfig[':now'];
  const options = prepareOptions(rawOptions);

  return {
    buildConfigs,
    options,
  };
}

module.exports = parseAndFilterShadowCljsBuilds;
