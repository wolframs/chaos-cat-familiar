export class HotkeyService {
  registerBindings() {
    throw new Error("HotkeyService.registerBindings not implemented");
  }
}

export class OverlayWindowService {
  showOverlay() {
    throw new Error("OverlayWindowService.showOverlay not implemented");
  }

  updateOverlay() {
    throw new Error("OverlayWindowService.updateOverlay not implemented");
  }

  hideOverlay() {
    throw new Error("OverlayWindowService.hideOverlay not implemented");
  }
}

export class AppActivationService {
  activateEditor() {
    throw new Error("AppActivationService.activateEditor not implemented");
  }

  activateTerminal() {
    throw new Error("AppActivationService.activateTerminal not implemented");
  }
}

export class NotificationService {
  async notify() {
    throw new Error("NotificationService.notify not implemented");
  }
}

export class TerminalLocatorService {
  async findContext() {
    throw new Error("TerminalLocatorService.findContext not implemented");
  }
}

export class SettingsStore {
  load() {
    throw new Error("SettingsStore.load not implemented");
  }

  save() {
    throw new Error("SettingsStore.save not implemented");
  }
}

export class HookInstallationService {
  async install() {
    throw new Error("HookInstallationService.install not implemented");
  }

  async diagnose() {
    throw new Error("HookInstallationService.diagnose not implemented");
  }
}
