# Mac Quick Start

This page covers the published macOS release `v0.1.3-rc.7.39-public.2`. For
`v0.1.3-rc.7.44` on macOS and Windows, use the README [install](../README.md#install)
and [quick start](../README.md#quick-start); Windows 11 x64 results are in its
[platform status](../README.md#platform-status).

For an identifiable shared profile, download the release VSIX into your current
directory, then run:

```sh
export STATA_WORKBENCH_PROFILE="$HOME/.stata-workbench-shared"
export STATA_WORKBENCH_PORT=17485
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --user-data-dir "$STATA_WORKBENCH_PROFILE/user-data" \
  --extensions-dir "$STATA_WORKBENCH_PROFILE/extensions" \
  --install-extension ./stata-workbench-shared-session-0.1.3-rc.7.39.vsix
git clone https://github.com/lzhs1995/stata-workbench-shared-session.git
cd stata-workbench-shared-session
git checkout v0.1.3-rc.7.39-public.2
python3 -B tools/verified_workbench.py --doctor
python3 -B tools/verified_workbench.py --request-permissions
python3 tools/verified_workbench.py --open --workspace "$PWD/examples/minimal-workspace"
```

Set `stataMcp.stataPath` to your licensed executable in this profile. Run
**Stata: Open Interactive Terminal**, then manually execute `display 1+1` to load
the backend. A port collision is a refusal, not permission to kill another editor.
Use a free `stataMcp.visibleBridgePort` and matching `STATA_WORKBENCH_PORT` if needed.
Approve the System Events Automation prompt in the same host used by the agent.
Accessibility is a separate requirement for window observation/opening.
The setup command never starts Stata; a pre-open diagnostic can report blocked
because no window exists yet. After granting permission, use `--open` once.
See [permission setup and empty-list troubleshooting](MAC_PERMISSIONS.md).

## Share The Session

In the Stata Terminal run `scalar public_shared_demo = 40`. Wait until ready.
From a shell using the same profile and port:

```sh
python3 tools/shared_stata.py --code 'scalar public_shared_demo = public_shared_demo + 2' --cwd "$PWD"
```

Back in the same Terminal run `display public_shared_demo` (42), then
`scalar drop public_shared_demo`. Choose another name if it already belongs to
your work. These commands do not clear the dataset. Human and AI take turns.
Do not type/edit during physical automation transactions.

Private request/response/log receipts live in `.stata-receipts/`; do not commit
them. On uncertain execution there is no automatic retry: inspect the receipt
and session first. Save research data/results before reset, restart or closing;
shared memory is not durable storage.

Configuration: `STATA_WORKBENCH_PROFILE`, `STATA_WORKBENCH_PORT`,
`STATA_WORKBENCH_CODE`. `--status` reads only; `--open` reuses the exact profile
or launches once. The AI client never launches, activates, resets or retries Stata.
