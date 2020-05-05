/* eslint-disable import/no-unresolved */
/* eslint-disable no-param-reassign */

const debug = require('debug')('shadow:');

const { createLambda } = require('@now/build-utils/lambda.js');
const download = require('@now/build-utils/fs/download.js');
const FileBlob = require('@now/build-utils/file-blob.js');
const FileFsRef = require('@now/build-utils/file-fs-ref.js');
const glob = require('@now/build-utils/fs/glob.js');
const { runNpmInstall } = require('@now/build-utils/fs/run-user-scripts.js');
const { makeAwsLauncher, makeNowLauncher } = require('@now/node/dist/launcher');
const nodeBridge = require('@now/node-bridge');

const fs = require('fs-extra');
const execa = require('execa');
const path = require('path');
const tar = require('tar');
const fetch = require('node-fetch');

const parseConfigFile = require('./parse-config-file');

const LAUNCHER_FILENAME = '___now_launcher';
const BRIDGE_FILENAME = '___now_bridge';
const HELPERS_FILENAME = '___now_helpers';

const javaVersion = '8.242.07.1';
const javaUrl = `https://corretto.aws/downloads/resources/${javaVersion}/amazon-corretto-${javaVersion}-linux-x64.tar.gz`;

debug.enabled = true; // always log

function getAWSLambdaHandler(entrypoint, config) {
  if (config.awsLambdaHandler) {
    return config.awsLambdaHandler;
  }

  if (process.env.NODEJS_AWS_HANDLER_NAME) {
    const { dir, name } = path.parse(entrypoint);
    const handlerName = process.env.NODEJS_AWS_HANDLER_NAME;
    return `${dir}${dir ? path.sep : ''}${name}.${handlerName}`;
  }

  return '';
}

async function installJava({ meta }) {
  if (meta.isDev) {
    debug('Dev mode; skipping java install');
    return Promise.resolve();
  }

  debug('Downloading java...');
  const res = await fetch(javaUrl);

  if (!res.ok) {
    throw new Error(`Failed to download: ${javaUrl}`);
  }

  const { HOME } = process.env;
  return new Promise((resolve, reject) => {
    res.body
      .on('error', reject)
      .pipe(tar.extract({ gzip: true, cwd: HOME }))
      .on('finish', () => resolve());
  });
}

async function installDependencies({ files, workPath, meta }) {
  if (meta.isDev) {
    debug('Dev mode; skipping dependency install');
    return;
  }

  const hasPkgJSON = Boolean(files['package.json']);
  if (hasPkgJSON) {
    debug('Installing dependencies...');
    await runNpmInstall(workPath, ['--prefer-offline']);
  } else {
    throw new Error('Missing package.json');
  }
}

async function downloadFiles({ files, entrypoint, workPath, meta }) {
  debug('Downloading files...');
  const downloadedFiles = await download(files, workPath, meta);
  const entryPath = downloadedFiles[entrypoint].fsPath;

  return { files: downloadedFiles, entryPath };
}

async function createLambdaForNode({ buildConfig, lambdas, workPath, config }) {
  debug(`Creating lambda for ${buildConfig.name} (${buildConfig.target})`);

  const entrypoint = buildConfig.outputTo;
  const awsLambdaHandler = getAWSLambdaHandler(entrypoint, config);
  const makeLauncher = awsLambdaHandler ? makeAwsLauncher : makeNowLauncher;
  const shouldAddHelpers = !(config.helpers === false || process.env.NODEJS_HELPERS === '0');

  const preparedFiles = {
    'index.js': new FileFsRef({
      fsPath: require.resolve(path.join(workPath, buildConfig.outputTo)),
    }),
  };

  debug(`Create lambda @`, entrypoint);
  const launcherFiles = {
    [`${LAUNCHER_FILENAME}.js`]: new FileBlob({
      data: makeLauncher({
        entrypointPath: `./index.js`,
        bridgePath: `./${BRIDGE_FILENAME}`,
        helpersPath: `./${HELPERS_FILENAME}`,
        awsLambdaHandler,
        shouldAddHelpers,
      }),
    }),
    [`${BRIDGE_FILENAME}.js`]: new FileFsRef({ fsPath: nodeBridge }),
  };

  if (shouldAddHelpers) {
    const nowIndex = require.resolve('@now/node');
    launcherFiles[`${HELPERS_FILENAME}.js`] = new FileFsRef({
      fsPath: path.join(path.dirname(nowIndex), 'helpers.js'),
    });
  }

  const lambda = await createLambda({
    files: {
      ...launcherFiles,
      ...preparedFiles,
    },
    handler: `${LAUNCHER_FILENAME}.launcher`,
    runtime: 'nodejs12.x',
  });

  lambdas[buildConfig.outputTo] = lambda;
}

async function createLambdaForStatic(buildConfig, lambdas, workPath) {
  debug(`Creating lambda for ${buildConfig.name} (${buildConfig.target})`);

  // Try to compute folder to serve.
  const outputPath = buildConfig.outputDir.replace(buildConfig.assetPath, '');

  const files = await glob(path.join(outputPath, '**'), workPath);

  Object.assign(lambdas, files);
}

const lambdaBuilders = {
  browser: createLambdaForStatic,
  'node-library': createLambdaForNode,
};

async function compileBuilds({ buildConfigs, workPath, config, options, meta }) {
  const { HOME, PATH } = process.env;

  const buildNames = buildConfigs.map((b) => b.name);
  debug('Detected builds:', buildNames);

  const env = meta.isDev
    ? {}
    : {
        M2: `${workPath}.m2`,
        JAVA_HOME: `${HOME}/amazon-corretto-${javaVersion}-linux-x64`,
        PATH: `${PATH}:${HOME}/amazon-corretto-${javaVersion}-linux-x64/bin`,
      };

  const buildMode = meta.isDev ? options.dev.compile : 'release';
  const invocation = ['shadow-cljs', buildMode, ...buildNames];

  try {
    debug(`Exec: '${invocation.join(' ')}':`);

    // eslint-disable-next-line no-console
    console.log();

    await execa('npx', invocation, {
      env,
      cwd: workPath,
      stdio: 'inherit',
    });
  } catch (err) {
    debug(`Failed to 'npx shadow-cljs ${buildMode} ...'`);
    throw err;
  }

  debug('Finished compile; preparing lambdas...');
  const lambdas = {};

  await Promise.all(
    buildConfigs.map(async (buildConfig) =>
      lambdaBuilders[buildConfig.target]({
        buildConfig,
        lambdas,
        workPath,
        config,
      })
    )
  );

  return lambdas;
}

async function build({ files, entrypoint, workPath, config, meta } = {}) {
  debug('Build requested. Changed Files: ', meta.filesChanged);

  if (entrypoint !== 'shadow-cljs.edn') {
    // nop; we return all the files to watch (IE: all of them) and that should
    // trigger a build with the shadow-cljs.edn as the entrypoint, which we
    // currently depend on to extract builds.
    return {};
  }

  const { files: downloadedFiles } = await downloadFiles({
    entrypoint,
    files,
    meta,
    workPath,
  });

  await installJava({ meta });
  await installDependencies({ files: downloadedFiles, workPath, meta });

  const input = downloadedFiles[entrypoint].fsPath;
  const { buildConfigs, options } = await parseConfigFile(input);
  const lambdas = await compileBuilds({ buildConfigs, workPath, config, options, meta });

  debug('Build completed.');

  return {
    output: lambdas,
    watch: Object.keys(files).filter((file) => {
      return file.endsWith('shadow-cljs.edn') || file.match(/\.clj[sc]?/);
    }),
    routes: [], // TODO we should be able to determine from buidlConfigs
  };
}

async function prepareCache({ cachePath, workPath }) {
  debug('Preparing cache...');
  ['.m2', '.shadow-cljs', 'node_modules'].forEach((folder) => {
    const p = path.join(workPath, folder);
    const cp = path.join(cachePath, folder);

    if (fs.existsSync(p)) {
      debug(`Caching ${folder} folder`);
      fs.removeSync(cp);
      fs.renameSync(p, cp);
    }
  });

  return {
    ...(await glob('.m2/**', cachePath)),
    ...(await glob('.shadow-cljs/**', cachePath)),
    ...(await glob('node_modules/**', cachePath)),
  };
}

module.exports = {
  build,
  prepareCache,

  version: 2,
};
