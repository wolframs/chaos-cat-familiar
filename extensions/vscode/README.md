# CCF Terminal Focus

Optional VS Code / Cursor helper, extension ID `wolframs.ccf-terminal-focus`.
It handles an editor URI and shows the integrated terminal whose `processId` matches `pid`.
CCF does not install it automatically.

## Package and install

From this directory, with Node/npm installed:

```powershell
npm exec --package @vscode/vsce -- vsce package
code --install-extension ./ccf-terminal-focus-1.0.0.vsix
```

For Cursor, install the VSIX through **Extensions → … → Install from VSIX** in Cursor instead.
Reload the editor if requested. Generated `*.vsix` files are local build outputs.

## Check the helper

In the editor's integrated PowerShell terminal, get its shell PID with `$PID`. Open this URI,
substituting that number, and accept the editor's extension-URI prompt:

```text
vscode://wolframs.ccf-terminal-focus/focus?pid=<shell-pid>
cursor://wolframs.ccf-terminal-focus/focus?pid=<shell-pid>
```

The matching terminal tab should become visible. The helper acts in the editor window receiving
the URI; it does not search other windows or focus Windows Terminal tabs.

CCF's editor activation service uses this URI when a `shellPid` is available. The generated sender
walks Windows process ancestry, skips the hook's own PowerShell and command wrappers, and reports
a recognized shell above Claude. It leaves the PID absent when ancestry is missing, inaccessible,
cyclic or unsupported. Nested interactive shells can still differ from the editor's terminal PID.

URI dispatch has no acknowledgement: CCF reports it as unconfirmed, even when this helper is
installed. Verify the matching tab manually in each editor window before relying on exact tab
focus. The normal session-return action prefers a supported window in the discovered shell's
ancestor chain, then uses project/title ranking. It foregrounds a window without selecting an
exact terminal tab; project/session identity remains useful when selecting the tab yourself.
Unrelated editor windows are excluded from fallback selection. When neither ancestry nor a
project title identifies a window, CCF can foreground another supported terminal window (reported
as `window_fallback`) or open Windows Terminal; that result does not establish a session match.

To remove it, uninstall **CCF Terminal Focus** in the editor's Extensions view. CCF's cleanup script
does not uninstall editor extensions.
