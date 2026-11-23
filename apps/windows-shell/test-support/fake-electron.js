import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { InProcessCoreHost } from "../core/core-in-process.js";
import { InProcessCompanionHost } from "../companion/companion-in-process.js";

// A Node stand-in for Electron's utilityProcess where Electron is not available (real-process tests, the load
// fixture): a child forked with structured-clone serialization, which is what a utility process speaks. The core's
// console mirror is dropped by default; its stderr shows. `children` lists the live ones (tests kill them).
export function nodeUtilityProcess({ execArgv = [], env = null, stdout = "ignore" } = {}) {
  const children = new Set();
  return {
    children,
    fork(modulePath, args = [], options = {}) {
      const child = childProcess.fork(modulePath, args, {
        serialization: "advanced",
        stdio: ["ignore", stdout, "inherit", "ipc"],
        env: { ...(env ?? process.env), ...(options.env ?? {}) },
        execArgv: [...(options.execArgv ?? []), ...execArgv]
      });
      children.add(child);
      child.once("exit", () => children.delete(child));
      return child;
    }
  };
}

class FakeWebContents extends EventEmitter {
  constructor(owner) {
    super();
    this.owner = owner;
    this.sent = [];
  }

  send(channel, payload) {
    this.sent.push({ channel, payload });
  }

  // Electron's postMessage with transferred ports (a window's own state port, step 5).
  postMessage(channel, message, transfer = []) {
    this.posted ??= [];
    const entry = { channel, message, ports: transfer };
    this.posted.push(entry);
    this.emit("test:posted", entry);
  }

  isDestroyed() {
    return this.owner.destroyed;
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
    this.alwaysOnTop = Boolean(options.alwaysOnTop);
    this.alwaysOnTopLevel = this.alwaysOnTop ? "floating" : null;
    this.zOrderCalls = [];
    this.focused = false;
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

  focus() {
    this.focused = true;
    this.zOrderCalls.push({ call: "focus" });
  }

  isFocused() {
    return this.focused;
  }

  // FakeBrowserWindow.readBack: how Windows hands bounds back at a fractional display scale (at 110 % a window set to
  // y 775, height 144 reads back as y 774, height 146), or null for exactly what was set.
  static readBack = null;

  setBounds(bounds) {
    this.bounds = { ...this.bounds, ...bounds };
    if (FakeBrowserWindow.readBack) this.bounds = FakeBrowserWindow.readBack(this.bounds);
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

  // Records z-order requests; isAlwaysOnTop mirrors Electron reading the real
  // WS_EX_TOPMOST bit, so tests can simulate Windows demoting a window.
  setAlwaysOnTop(flag, level = "floating") {
    this.alwaysOnTop = Boolean(flag);
    this.alwaysOnTopLevel = flag ? level : null;
    this.zOrderCalls.push({ call: "setAlwaysOnTop", flag: Boolean(flag), level });
  }

  isAlwaysOnTop() {
    return this.alwaysOnTop;
  }

  setIgnoreMouseEvents(ignore) {
    this.ignoresMouseEvents = ignore;
  }

  setOpacity(value) {
    this.opacity = value;
  }

  moveTop() {
    this.zOrderCalls.push({ call: "moveTop" });
  }

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
    this.webContents.emit("destroyed");
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
    return this.invokeFrom(null, channel, ...args);
  }

  // As a given window's renderer calls it (event.sender is its webContents).
  async invokeFrom(sender, channel, ...args) {
    const handler = this.handlers.get(channel);
    if (!handler) {
      throw new Error(`Missing IPC handler for ${channel}`);
    }
    return handler({ sender }, ...args);
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
  // popupCalls: every Menu.popup, with the template and the window it popped on (the cat's menu).
  const menu = {
    lastTemplate: null,
    popupCalls: [],
    buildFromTemplate(template) {
      menu.lastTemplate = template;
      return {
        template,
        popup(options = {}) { menu.popupCalls.push({ template, window: options.window ?? null }); }
      };
    }
  };
  const clipboard = {
    text: null,
    writeText(value) { clipboard.text = String(value); },
    readImage() { return { isEmpty: () => true }; }
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
    clipboard,
    shell,
    screen,
    globalShortcut,
    Notification: FakeNotification,
    // Not Electron's: without utilityProcess the runtime composes core and companion in this process, with these hosts
    // (main itself never loads either composition; process-split plan, step 7).
    inProcessHosts: { core: InProcessCoreHost, companion: InProcessCompanionHost }
  };
}
