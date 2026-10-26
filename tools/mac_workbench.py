"""macOS process/window adapter; preserves the existing permission protocol."""
from pathlib import Path
import subprocess
import mac_permissions as permissions


def output(argv):
    return subprocess.check_output(argv, text=True, timeout=10).strip()


class MacWorkbench:
    def __init__(self, profile, code, port):
        self.profile, self.code, self.port = Path(profile), code, port

    def code_instances(self):
        rows = []
        expected = str(self.profile / "user-data")
        for line in output(["/bin/ps", "-ax", "-o", "pid=,args="]).splitlines():
            fields = line.strip().split(None, 1)
            if len(fields) != 2 or "/Contents/MacOS/" not in fields[1]:
                continue
            pid, args = int(fields[0]), fields[1]
            # ps does not preserve shell quotes around paths containing spaces.
            # Bind the executable independently, then the full profile argument.
            if not any(x in args for x in ("--user-data-dir " + expected, "--user-data-dir=" + expected)):
                continue
            try:
                executable = output(["/bin/ps", "-p", str(pid), "-o", "comm="])
            except subprocess.CalledProcessError:
                continue
            expected_executable = Path(self.code).resolve().parents[3] / "MacOS/Code"
            if Path(executable).resolve() == expected_executable:
                suffix = args.split("--user-data-dir", 1)[1].lstrip("= ")
                if suffix == expected or suffix.startswith(expected + " --"):
                    rows.append({"pid": pid, "launcher": True})
        return rows

    def bridge_owner(self):
        run = subprocess.run(["/usr/sbin/lsof", "-nP", f"-iTCP:{self.port}", "-sTCP:LISTEN", "-t"],
                             capture_output=True, text=True, timeout=10)
        if run.returncode == 1 and not run.stdout.strip() and not run.stderr.strip():
            return None
        if run.returncode != 0:
            raise RuntimeError("listener census failed")
        pids = set(run.stdout.split())
        if len(pids) != 1:
            raise RuntimeError("listener owner is not unique")
        pid = int(pids.pop())
        ppid = int(output(["/bin/ps", "-p", str(pid), "-o", "ppid="]))
        return {"pid": pid, "ppid": ppid, "launcher": any(i["pid"] == ppid for i in self.code_instances())}

    def launcher_window_count(self, pid):
        obs = permissions.window_observation(pid)
        permissions.require_window_observation({"windowObservation": obs, "axWindowCount": obs["count"]})
        return obs["count"]

    def screen_locked(self):
        text = output(["/usr/sbin/ioreg", "-n", "Root", "-d1"])
        return '"CGSSessionScreenIsLocked" = Yes' in text or '"ScreenIsLocked" = Yes' in text


def activate_once(pid):
    output(["/usr/bin/osascript", "-e",
        f'tell application "System Events"\nset p to first application process whose unix id is {int(pid)}\nset frontmost of p to true\nend tell'])
    actual = int(output(["/usr/bin/osascript", "-e",
        'tell application "System Events" to unix id of first application process whose frontmost is true']))
    return {"ok": actual == pid, "actualPid": actual, "targetPid": pid}

