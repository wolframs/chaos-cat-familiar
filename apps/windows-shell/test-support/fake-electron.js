import { EventEmitter } from "node:events";

class FakeWebContents extends EventEmitter {
  constructor(owner) {
    super();
    this.owner = owner;
    this.sent = [];
  }

  send(channel, payload) {
    this.sent.push({ channel, payload });
  }
}

export class FakeBrowserWindow extends EventEmitter {
  static windowsByWebContents = new Map();

  static fromWebContents(webContents) {
    return FakeBrowserWindow.windowsByWebContents.get(webContents) ?? null;
  }

  constructor(options = {}) {
    super();
    this.options = options;
    this.bounds = {
      x: 100,
      y: 100,
      width: options.width ?? 420,
      height: options.height ?? 320
    };
    this.visible = Boolean(options.show);
    this.destroyed = false;
    this.minimized = false;
    this.maximized = false;
    this.title = options.title ?? "";
    this.webContents = new FakeWebContents(this);
    FakeBrowserWindow.windowsByWebContents.set(this.webContents, this);
  }

  loadFile(filePath) {
    this.loadedFile = filePath;
  }

  show() {
    this.visible = true;
  }

  showInactive() {
    this.visible = true;
  }

  hide() {
    this.visible = false;
  }

  focus() {}

  setBounds(bounds) {
    this.bounds = { ...this.bounds, ...bounds };
  }

  getBounds() {
    return { ...this.bounds };
  }

  isVisible() {
    return this.visible;
  }

  isMinimized() {
    return this.minimized;
  }

  minimize() {
    this.minimized = true;
  }

  restore() {
    this.minimized = false;
  }

  maximize() {
    this.maximized = true;
  }

  unmaximize() {
    this.maximized = false;
  }

  isMaximized() {
    return this.maximized;
  }

  setAlwaysOnTop() {}

  setIgnoreMouseEvents(ignore) {
    this.ignoresMouseEvents = ignore;
  }

  setOpacity(value) {
    this.opacity = value;
  }

  moveTop() {}

  close() {
    this.emit("close", {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      }
    });
    if (!this.destroyed) {
      this.visible = false;
    }
  }

  destroy() {
    this.destroyed = true;
    this.visible = false;
    FakeBrowserWindow.windowsByWebContents.delete(this.webContents);
  }

  isDestroyed() {
    return this.destroyed;
  }

  getTitle() {
    return this.title;
  }
}

export class FakeTray extends EventEmitter {
  constructor(icon) {
    super();
    this.icon = icon;
    this.destroyed = false;
  }

  setToolTip(value) {
    this.toolTip = value;
  }

  setContextMenu(menu) {
    this.menu = menu;
  }

  destroy() {
    this.destroyed = true;
  }
}

export class FakeScreen extends EventEmitter {
  constructor() {
    super();
    this.primaryDisplay = {
      id: 1,
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      bounds: { x: 0, y: 0, width: 1920, height: 1080 }
    };
  }

  getAllDisplays() {
    return [this.primaryDisplay];
  }

  getPrimaryDisplay() {
    return this.primaryDisplay;
  }

  getCursorScreenPoint() {
    return { x: 100, y: 100 };
  }

  getDisplayMatching() {
    return this.primaryDisplay;
  }
}

export class FakeGlobalShortcut {
  constructor() {
    this.bindings = [];
    this.unregisterAllCalls = 0;
  }

  register(accelerator, handler) {
    this.bindings.push({ accelerator, handler });
    return true;
  }

  unregisterAll() {
    this.unregisterAllCalls += 1;
    this.bindings = [];
  }
}

export class FakeNotification {
  static isSupported() {
    return true;
  }

  constructor(payload) {
    this.payload = payload;
  }

  on() {}

  show() {}
}

export class FakeIpcMain extends EventEmitter {
  constructor() {
    super();
    this.handlers = new Map();
  }

  handle(channel, handler) {
    this.handlers.set(channel, handler);
  }

  removeHandler(channel) {
    this.handlers.delete(channel);
  }

  async invoke(channel, ...args) {
    const handler = this.handlers.get(channel);
    if (!handler) {
      throw new Error(`Missing IPC handler for ${channel}`);
    }
    return handler({ sender: null }, ...args);
  }
}

export class FakeApp extends EventEmitter {
  constructor(paths = {}) {
    super();
    this.paths = {
      home: paths.home ?? "C:/fake/home",
      appData: paths.appData ?? "C:/fake/appdata"
    };
    this.loginItemSettings = { openAtLogin: false };
    this.exitCalls = [];
    this.protocolRegistrations = [];
    this.defaultApp = true;
    this.isPackaged = false;
  }

  getPath(name) {
    return this.paths[name];
  }

  setAppUserModelId(value) {
    this.appUserModelId = value;
  }

  getLoginItemSettings() {
    return this.loginItemSettings;
  }

  setLoginItemSettings(value) {
    this.loginItemSettings = { ...this.loginItemSettings, ...value };
  }

  setAsDefaultProtocolClient(...args) {
    this.protocolRegistrations.push(args);
    return true;
  }

  quit() {
    this.quitCalled = true;
  }

  exit(code = 0) {
    this.exitCalls.push(code);
    this.emit("exit", code);
  }
}

export function createFakeElectron(paths = {}) {
  const app = new FakeApp(paths);
  const screen = new FakeScreen();
  const ipcMain = new FakeIpcMain();
  const globalShortcut = new FakeGlobalShortcut();
  const shell = {
    openExternalCalls: [],
    openPathCalls: [],
    async openExternal(target) {
      this.openExternalCalls.push(target);
      return "";
    },
    async openPath(target) {
      this.openPathCalls.push(target);
      return "";
    }
  };
  const menu = {
    lastTemplate: null,
    buildFromTemplate(template) {
      menu.lastTemplate = template;
      return {
        template,
        popup() {}
      };
    }
  };
  const nativeImage = {
    createFromDataURL(value) {
      return { value };
    }
  };

  return {
    app,
    BrowserWindow: FakeBrowserWindow,
    Tray: FakeTray,
    Menu: menu,
    ipcMain,
    nativeImage,
    shell,
    screen,
    globalShortcut,
    Notification: FakeNotification
  };
}
