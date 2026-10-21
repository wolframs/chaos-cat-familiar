const vscode = require('vscode');

function activate(context) {
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri) {
        // /setup path: just accept the URI to trigger Cursor's permission prompt
        if (uri.path === '/setup') return;

        const params = new URLSearchParams(uri.query);
        const targetPid = parseInt(params.get('pid'), 10);
        if (!targetPid || isNaN(targetPid)) return;

        for (const terminal of vscode.window.terminals) {
          const pid = await terminal.processId;
          if (pid === targetPid) {
            terminal.show(false);
            return;
          }
        }
      },
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
