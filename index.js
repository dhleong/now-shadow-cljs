/* eslint-disable import/no-unresolved */
/* eslint-disable no-param-reassign */
/* eslint-disable no-console */

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
    console.log('Dev mode; skipping java install');
    return Promise.resolve();
  }

  console.log('Downloading java...');
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
    console.log('Dev mode; skipping dependency install');
    return;
  }
  const hasPkgJSON = Boolean(files['package.json']);
  if (hasPkgJSON) {
    console.log('Installing dependencies...');
    await runNpmInstall(workPath, ['--prefer-offline']);
  } else {
    throw new Error('Missing package.json');
  }
}

async function downloadFiles({ files, entrypoint, workPath, meta }) {
  console.log('Downloading files...');
  const downloadedFiles = await download(files, workPath, meta);
  const entryPath = downloadedFiles[entrypoint].fsPath;

  return { files: downloadedFiles, entryPath };
}

async function createLambdaForNode({ buildConfig, lambdas, workPath, config }) {
  console.log(`Creating lambda for ${buildConfig.name} (${buildConfig.target})`);

  const entrypoint = buildConfig.outputTo;
  const awsLambdaHandler = getAWSLambdaHandler(entrypoint, config);
  const makeLauncher = awsLambdaHandler ? makeAwsLauncher : makeNowLauncher;
  const shouldAddHelpers = !(config.helpers === false || process.env.NODEJS_HELPERS === '0');

  const preparedFiles = {
    'index.js': new FileFsRef({
      fsPath: require.resolve(path.join(workPath, buildConfig.outputTo)),
    }),
  };

  console.log(`Create lambda @`, entrypoint);
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
  console.log(`Creating lambda for ${buildConfig.name} (${buildConfig.target})`);

  // Try to compute folder to serve.
  const outputPath = buildConfig.outputDir.replace(buildConfig.assetPath, '');

  const files = await glob(path.join(outputPath, '**'), workPath);

  Object.assign(lambdas, files);
}

const lambdaBuilders = {
  browser: createLambdaForStatic,
  'node-library': createLambdaForNode,
};

exports.build = async ({ files, entrypoint, workPath, config, meta } = {}) => {
  if (entrypoint !== 'shadow-cljs.edn') {
    // nop
    console.log('SKIP', files, entrypoint, config, meta);
    return {};
  }

  const { HOME, PATH } = process.env;

  const { files: downloadedFiles } = await downloadFiles({
    entrypoint,
    files,
    meta,
    workPath,
  });

  const { stdout } = await execa('ls', ['-a'], {
    cwd: workPath,
    stdio: 'inherit',
  });

  console.log(stdout);

  await installJava({ meta });
  await installDependencies({ files: downloadedFiles, workPath, meta });

  const input = downloadedFiles[entrypoint].fsPath;
  const buildConfigs = await parseConfigFile(input);
  const buildNames = buildConfigs.map((b) => b.name);
  console.log('Detected builds:', buildNames);

  const env = meta.isDev
    ? {}
    : {
        M2: `${workPath}.m2`,
        JAVA_HOME: `${HOME}/amazon-corretto-${javaVersion}-linux-x64`,
        PATH: `${PATH}:${HOME}/amazon-corretto-${javaVersion}-linux-x64/bin`,
      };

  try {
    await execa('npx', ['shadow-cljs', 'release', ...buildNames], {
      env,
      cwd: workPath,
      stdio: 'inherit',
    });
  } catch (err) {
    console.error('Failed to `npx shadow-cljs release ...`');
    throw err;
  }

  const lambdas = {};

  console.log('Preparing lambdas...');
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
};

exports.prepareCache = async ({ cachePath, workPath }) => {
  console.log('Preparing cache...');
  ['.m2', '.shadow-cljs', 'node_modules'].forEach((folder) => {
    const p = path.join(workPath, folder);
    const cp = path.join(cachePath, folder);

    if (fs.existsSync(p)) {
      console.log(`Caching ${folder} folder`);
      fs.removeSync(cp);
      fs.renameSync(p, cp);
    }
  });

  return {
    ...(await glob('.m2/**', cachePath)),
    ...(await glob('.shadow-cljs/**', cachePath)),
    ...(await glob('node_modules/**', cachePath)),
  };
};
