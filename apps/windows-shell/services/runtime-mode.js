export function detectRuntimeMode({ app, processLike = process } = {}) {
  const isPackaged = Boolean(app?.isPackaged);
  const isDefaultApp = Boolean(processLike?.defaultApp);

  return {
    isPackaged,
    isDefaultApp,
    mode: isPackaged ? "packaged" : "development"
  };
}
