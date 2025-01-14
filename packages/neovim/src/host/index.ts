import * as util from 'util';
import { attach } from '../attach';
import { logger } from '../utils/logger';
import { loadPlugin, LoadPluginOptions } from './factory';
import { NvimPlugin } from './NvimPlugin';

export interface Response {
  send(resp: any, isError?: boolean): void;
}

export class Host {
  public loaded: { [index: string]: NvimPlugin };

  public nvim: any;

  constructor() {
    // Map for loaded plugins
    this.loaded = {};
    this.handler = this.handler.bind(this);
    this.handlePlugin = this.handlePlugin.bind(this);
  }

  getPlugin(filename: string, options: LoadPluginOptions = {}) {
    let plugin = this.loaded[filename];
    const shouldUseCachedPlugin =
      plugin && plugin.shouldCacheModule && !plugin.alwaysInit;

    if (shouldUseCachedPlugin) {
      logger.debug('getPlugin.useCachedPlugin');
      return plugin;
    }

    plugin = loadPlugin(filename, this.nvim, {
      ...options,
      cache: plugin && plugin.shouldCacheModule,
    });

    logger.debug('getPlugin.alwaysInit', plugin && !plugin.alwaysInit);
    this.loaded[filename] = plugin;

    return plugin;
  }

  // Route incoming request to a plugin
  async handlePlugin(method: string, args: any[]) {
    // ignore methods that start with nvim_ prefix (e.g. when attaching to buffer and listening for notifications)
    if (method.startsWith('nvim_')) return null;
    logger.debug('host.handlePlugin: ', method);

    // Parse method name
    const procInfo = method.split(':');
    if (process.platform === 'win32') {
      // Windows-style absolute paths is formatted as [A-Z]:\path\to\file.
      // Forward slash as path separator is ok
      // so Neovim uses it to avoid escaping backslashes.
      //
      // For absolute path of cmd.exe with forward slash as path separator,
      // method.split(':') returns ['C', '/Windows/System32/cmd.exe', ...].
      // procInfo should be ['C:/Windows/System32/cmd.exe', ...].
      const networkDrive = procInfo.shift();
      procInfo[0] = `${networkDrive}:${procInfo[0]}`;
    }
    const filename = procInfo[0];
    const type = procInfo[1];
    const procName = `${procInfo.slice(2).join(' ')}`;

    const plugin = this.getPlugin(filename);

    if (!plugin) {
      const msg = `Could not load plugin: ${filename}`;
      logger.error(msg);
      throw new Error(msg);
    }

    return plugin.handleRequest(procName, type, args);
  }

  handleRequestSpecs(method: string, args: any[], res: Response) {
    const filename = args[0];
    logger.debug(`requested specs for ${filename}`);
    // Can return null if there is nothing defined in plugin
    const plugin = this.getPlugin(filename);
    const specs = (plugin && plugin.specs) || [];
    logger.debug(JSON.stringify(specs));
    res.send(specs);
    logger.debug(`specs: ${util.inspect(specs)}`);
  }

  async handler(method: string, args: any[], res: Response) {
    logger.debug('request received: ', method);
    // 'poll' and 'specs' are requests by neovim,
    // otherwise it will
    if (method === 'poll') {
      // Handshake for neovim
      res.send('ok');
    } else if (method === 'specs') {
      // Return plugin specs
      this.handleRequestSpecs(method, args, res);
    } else {
      try {
        const plugResult = await this.handlePlugin(method, args);
        res.send(
          !plugResult || typeof plugResult === 'undefined' ? null : plugResult
        );
      } catch (err) {
        res.send(err.toString(), true);
      }
    }
  }

  async start({ proc }: { proc: NodeJS.Process }) {
    logger.debug('host.start');
    // stdio is reversed since it's from the perspective of Neovim
    const nvim = attach({ reader: proc.stdin, writer: proc.stdout });
    this.nvim = nvim;

    nvim.on('request', this.handler);
    nvim.on('notification', this.handlePlugin);
    nvim.on('disconnect', () => {
      logger.debug('host.disconnected');
    });
  }
}
