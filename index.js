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
const SOURCEMAP_SUPPORT_FILENAME = '__sourcemap_support';

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

async function cleanSourceForDevMode(sourceFilePath) {
  let source = (await fs.readFile(sourceFilePath)).toString();

  // NOTE: in dev mode, shadow-cljs requires and calls install() in source-map-support.
  // The version of source-map-support that now bundles already calls install()
  // just by requiring it

  source = source.replace(
    `require('source-map-support').install()`,
    `require('./${SOURCEMAP_SUPPORT_FILENAME}')`
  );

  // Also, __dirname exists but does not point to the build directory, so
  // let's remove the if() that sets an absolute path for imports

  source = source.replace(`if (__dirname == '.')`, `if (__dirname != '.')`);

  return source;
}

async function createLambdaForNode({ buildConfig, buildMode, lambdas, workPath, config }) {
  debug(`Creating lambda for ${buildConfig.name} (${buildConfig.target})`);

  const entrypoint = buildConfig.outputTo;
  const awsLambdaHandler = getAWSLambdaHandler(entrypoint, config);
  const makeLauncher = awsLambdaHandler ? makeAwsLauncher : makeNowLauncher;
  const shouldAddHelpers = !(config.helpers === false || process.env.NODEJS_HELPERS === '0');
  const shouldAddSourcemapSupport = buildMode !== 'release';

  const sourceFilePath = require.resolve(path.join(workPath, buildConfig.outputTo));
  const preparedFiles = {
    'index.js': shouldAddSourcemapSupport
      ? new FileBlob({
          data: await cleanSourceForDevMode(sourceFilePath),
        })
      : new FileFsRef({
          fsPath: sourceFilePath,
        }),
  };

  debug(`Create lambda @`, entrypoint);
  const launcherFiles = {
    [`${LAUNCHER_FILENAME}.js`]: new FileBlob({
      data: makeLauncher({
        entrypointPath: `./index.js`,
        bridgePath: `./${BRIDGE_FILENAME}`,
        helpersPath: `./${HELPERS_FILENAME}`,
        sourcemapSupportPath: `./${SOURCEMAP_SUPPORT_FILENAME}`,
        awsLambdaHandler,
        shouldAddHelpers,
        shouldAddSourcemapSupport,
      }),
    }),
    [`${BRIDGE_FILENAME}.js`]: new FileFsRef({ fsPath: nodeBridge }),
  };

  if (shouldAddHelpers) {
    launcherFiles[`${HELPERS_FILENAME}.js`] = new FileFsRef({
      fsPath: require.resolve('@now/node/dist/helpers'),
    });
  }

  if (shouldAddSourcemapSupport) {
    launcherFiles[`${SOURCEMAP_SUPPORT_FILENAME}.js`] = new FileFsRef({
      fsPath: require.resolve('@now/node/dist/source-map-support'),
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

async function createLambdaForStatic({ buildConfig, lambdas, workPath }) {
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

let hasStartedServer = false;

async function ensureServerStarted({ workPath }) {
  if (hasStartedServer) return;

  debug('Ensuring build server is running...');
  const serverProc = execa('npx', ['shadow-cljs', 'server'], {
    all: true,
    cwd: workPath,
  });

  // wait for the server to start (or to detect it's already running)
  await new Promise((resolve) => {
    serverProc.all.on('data', (data) => {
      const out = data.toString();
      if (out.includes('already running')) {
        debug('Build server detected.');
        resolve();
      } else if (out.includes(' running at')) {
        debug('Started build server.');
        resolve();
      }
    });
  });

  hasStartedServer = true;
}

async function compileBuilds({ buildConfigs, workPath, config, options, meta }) {
  const { HOME, PATH } = process.env;

  const buildNames = buildConfigs.map((b) => b.name);
  debug('Detected builds:', buildNames);

  if (meta.isDev && options.dev.server) {
    await ensureServerStarted({ workPath });
  }

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
        buildMode,
        lambdas,
        workPath,
        config,
        meta,
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

    // NOTE we should be able to determine this from buildConfigs, but
    routes: [],
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
